## index.d.ts

```ts
declare namespace mod_d_exports {
  export { foo };
}
declare const foo: number;
//#region index.d.ts
declare const a: string;
declare const b: string;
type Str = string;
declare function fn(param: Str): string;
interface Obj {
  nested: {
    key: string;
  };
  method(): void;
  "foo-bar": number;
}
declare namespace Ns {
  type Str = string;
  type Foo<T> = T;
  type Obj = {
    id: string;
  };
}
//#endregion
export { mod_d_exports as Mod, Obj, a, b, fn };
//# sourceMappingURL=index.d.ts.map

```

## index.d.ts.map

```map
{"version":3,"names":[],"sources":["../../fixtures/source-map/mod.ts","../../fixtures/source-map/index.ts"],"sourcesContent":["export const foo: number = 42\n","export const a: string = ''\n\nexport const b: string = ''\n\nconsole.log('Hello World!')\n\ntype Str = string\nexport function fn(param: Str): string {\n  return param\n}\n\nexport interface Obj {\n  nested: {\n    key: string\n  }\n  method(): void\n  'foo-bar': number\n}\n\nexport namespace Ns {\n  export type Str = string\n  export type Foo<T> = T\n  export type Obj = {\n    id: string\n  }\n}\n\nexport * as Mod from './mod'\n"],"mappings":";;;AAAA,cAAa;;ACAb,cAAa;AAEb,cAAa;KAIR;AACL,iBAAgB,GAAG,OAAO;UAIT,IAAG;EAClB,QAAQ;IACN;;EAEF;EACA;;kBAGe,GAAG;OACN;OACA,IAAI,KAAK;OACT,MAAM;IAChB","file":"index.d.ts"}
```
