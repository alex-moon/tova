/* Ambient declaration for `mathjs/number`: the package exports map is invisible to classic moduleResolution, but runtime resolution works — this only fills the TypeScript gap. */
declare module 'mathjs/number' {
  export * from 'mathjs';
}
