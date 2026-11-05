// Baseline dictionary. Every user-facing string the new UI adds lives here;
// the English table is typed against it so a missing key fails `tsc`.
export const zh = {
  locale: {
    label: "语言",
    system: "跟随系统",
    zh: "中文",
    en: "English",
    saveFailed: "语言设置未能保存，下次启动会恢复",
    pendingBot: "下次发布后 bot 使用{lang}",
    syncNow: "立即同步",
    syncing: "同步中…",
  },
} as const;

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
