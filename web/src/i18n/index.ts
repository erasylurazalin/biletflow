// One dictionary per language. Both server and client components import this; the
// three files are small enough that shipping all of them beats loading them lazily.
import type { Locale } from './config';
import { en, type Dictionary } from './dictionaries/en';
import { kk } from './dictionaries/kk';
import { ru } from './dictionaries/ru';

export const dictionaries: Record<Locale, Dictionary> = { kk, ru, en };

export type { Dictionary };
