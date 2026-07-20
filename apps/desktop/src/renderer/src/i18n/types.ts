export type TranslationShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string ? string : TranslationShape<T[Key]>;
};
