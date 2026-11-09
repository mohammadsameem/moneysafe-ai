/**
 * Which table columns show at which width. The sidebar takes 256 px from 768 px up, so a table at
 * 768 to 1023 px has only about 450 px: low-priority columns are dropped there, while a phone (no
 * sidebar) and a wide screen show them. Written out in full so Tailwind finds the class names.
 */

/** Shown from 640 px up, hidden while the sidebar is narrow (768 to 1023 px), shown again from 1024 px. */
export const COL_FROM_LG = "hidden sm:table-cell md:hidden lg:table-cell";

/** The same, but only back again from 1280 px (for the widest, least important columns). */
export const COL_FROM_XL = "hidden sm:table-cell md:hidden xl:table-cell";
