# 源数据转换（CSV / JSON → Parquet）

- 命令：`node tools/source-to-parquet.mjs <input> --output <file.parquet>`
- 定位：Builder 的**输入准备**工具，不是 SDK 功能
- 依赖：`hyparquet-writer`（根目录 devDependency，不进入发布包）

## 1. 为什么放在工具里

Builder 的契约是「接收已存在的 Parquet」——它不猜测类型、不做列裁剪，只负责把表、向量与 Manifest 组装成可校验的数据包。把 CSV/JSON 推断塞进 Builder 会让「输入契约」变得模糊，也会把写入依赖带进 SDK。

所以转换是独立工具，输出两样东西：Parquet 文件，以及一段可直接粘贴到 Manifest 的列声明。两者由同一次推断产生，不会各写一份而漂移。

## 2. 用法

```bash
node tools/source-to-parquet.mjs rows.csv   --output source/documents.parquet
node tools/source-to-parquet.mjs rows.jsonl --output source/documents.parquet
node tools/source-to-parquet.mjs rows.json  --output source/documents.parquet   # 对象数组
```

需要显式指定格式时用 `--format csv|json`（默认按扩展名）。

输出示例：

```json
{
  "input": "rows.csv",
  "output": "source/documents.parquet",
  "format": "csv",
  "rows": 3,
  "parquetBytes": 536,
  "columns": [
    { "name": "id", "type": "string", "nullable": false },
    { "name": "title", "type": "string", "nullable": true },
    { "name": "rating", "type": "float64", "nullable": false },
    { "name": "active", "type": "boolean", "nullable": false }
  ]
}
```

## 3. 类型推断规则

| 输入值 | 结果 |
| --- | --- |
| JSON 原生 `number`（整数且在 int32 范围内） | `int32` |
| JSON 原生整数超出 int32 | `int64`（写入时转 BigInt） |
| JSON 原生带小数的数字 | `float64` |
| `true` / `false` | `boolean` |
| 字符串 | `string` |
| JSON 对象 / 数组（可含 null 元素） | `json`（原样写入 Parquet JSON，Manifest 声明为 `json`） |
| 空值（`null`、CSV 空字段） | 该列 `nullable: true` |

CSV 的所有值先当字符串看，只有**无损**转换才收下：

- `"1"` → 整数；`"1.5"` → 浮点；
- `"001"` 保持字符串（转成数字会丢前导零）；
- `"1e3"` 保持字符串（`String(Number("1e3")) !== "1e3"`）；
- `"true"` / `"false"` → 布尔，其余字符串保持原样。

同一列出现不兼容类型（如 `1` 与 `"x"`）直接报错，不做隐式字符串化——那会让数据问题推迟到查询时才暴露。

## 4. 明确不支持

| 项 | 原因 |
| --- | --- |
| 时间戳类型推断 | 时区与精度语义需要显式声明；当前一律按字符串处理 |
| 增量追加 | 每次转换生成完整文件，符合「不可变输入」模型 |
| 分片 / 多文件表 | 一个 CSV/JSON 对应一张表的一个 Parquet 文件 |

## 5. 与 Builder 的衔接

```bash
node tools/source-to-parquet.mjs rows.csv --output source/documents.parquet
# 把输出的 columns 粘进 buildPackage({ tables: [{ columns: [...] }] })
npm run fixture            # 或直接调用 buildPackage()
npx weisql validate ./fixture --l4
```

`--l4` 会通过 DuckDB 读一遍 Parquet，确认列名/类型与 Manifest 一致——这是唯一能发现「Manifest 写错类型但哈希仍然对得上」的检查。
