/**
 * Browser stand-in for the Node built-ins that `@weisql/sdk`'s Node-only
 * modules import. Those modules (the file reader, the builder) are never used
 * by the desktop UI, so Rollup tree-shakes them; this shim only exists so the
 * bundle can resolve their imports instead of failing at build time.
 */
function unavailable(name: string): never {
  throw new Error(`node:${name} is not available in the desktop webview`);
}

export const copyFile = () => unavailable("fs.copyFile");
export const mkdir = () => unavailable("fs.mkdir");
export const open = () => unavailable("fs.open");
export const readFile = () => unavailable("fs.readFile");
export const readdir = () => unavailable("fs.readdir");
export const realpath = () => unavailable("fs.realpath");
export const rename = () => unavailable("fs.rename");
export const rm = () => unavailable("fs.rm");
export const stat = () => unavailable("fs.stat");
export const writeFile = () => unavailable("fs.writeFile");
export const randomUUID = () => unavailable("crypto.randomUUID");

export default {
  join: (...parts: string[]) => parts.filter(Boolean).join("/"),
  resolve: (...parts: string[]) => parts.filter(Boolean).join("/"),
  dirname: (value: string) => value.replace(/[/\\][^/\\]*$/, ""),
  basename: (value: string) => value.replace(/^.*[/\\]/, ""),
  extname: (value: string) => {
    const match = /\.[^./\\]+$/.exec(value);
    return match === null ? "" : match[0];
  },
  sep: "/",
};
