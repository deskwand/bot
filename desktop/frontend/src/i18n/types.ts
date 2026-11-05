import type { zh } from "./zh";

/** Same shape as the baseline table, but every leaf is a string. */
export type DeepString<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepString<T[K]>;
};

export type Messages = DeepString<typeof zh>;

type Paths<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
    }[keyof T & string];

/** Dotted paths into the dictionary, e.g. "locale.label". */
export type MessageKey = Paths<typeof zh>;
