/*
 * mathjs exposes its number-only build through a package `exports` map
 * (`mathjs/number`), which this package's classic `moduleResolution: "node"`
 * cannot read. Runtime resolution is fine — Node and jest both understand the
 * exports map — so this ambient declaration only fills the TypeScript gap: the
 * number-only entry re-exports the main API surface.
 */
declare module 'mathjs/number' {
  export * from 'mathjs';
}
