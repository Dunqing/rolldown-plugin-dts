// index.d.ts
//#region tests/rollup-plugin-dts/typeof-undefined-alias/index.d.ts
declare let undefined: string;
type T = typeof undefined;
//#endregion
export { T, undefined };