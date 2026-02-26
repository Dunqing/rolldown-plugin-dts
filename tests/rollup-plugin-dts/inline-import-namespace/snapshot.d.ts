// index.d.ts
declare namespace bar_d_exports {
  export { Bar, IBar };
}
//#region tests/rollup-plugin-dts/inline-import-namespace/bar.d.ts
declare class Bar {}
interface IBar {}
//#endregion
//#region tests/rollup-plugin-dts/inline-import-namespace/index.d.ts
interface Foo {
  ns: typeof bar_d_exports;
}
//#endregion
export { Foo };