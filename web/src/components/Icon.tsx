export type IconName = 'grid' | 'search' | 'tasks' | 'database' | 'plus' | 'arrow' | 'back' | 'close' | 'check' | 'download' | 'upload' | 'file' | 'clock' | 'shield' | 'refresh' | 'filter' | 'copy' | 'chevron' | 'archive' | 'menu' | 'spark' | 'link';
const shapes: Record<IconName, string[]> = {
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  tasks: ['M9 5h12M9 12h12M9 19h12M2 5l1.5 1.5L6 3M2 12l1.5 1.5L6 10M2 19l1.5 1.5L6 17'],
  database: ['M20 5c0 2-4 3-8 3S4 7 4 5s4-3 8-3 8 1 8 3ZM4 5v14c0 2 4 3 8 3s8-1 8-3V5M4 12c0 2 4 3 8 3s8-1 8-3'],
  plus: ['M12 5v14M5 12h14'], arrow: ['M4 12h16m-6-6 6 6-6 6'], back: ['M20 12H4m6-6-6 6 6 6'], close: ['m6 6 12 12M6 18 18 6'], check: ['m5 12 4 4L19 6'],
  download: ['M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'], upload: ['M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5'],
  file: ['M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 13h8M8 17h5'], clock: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2'],
  shield: ['m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z', 'm8 12 3 3 5-6'], refresh: ['M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6'],
  filter: ['M4 5h16M7 12h10M10 19h4'], copy: ['M9 9h12v12H9zM15 5V2H2v13h3'], chevron: ['m9 5 7 7-7 7'], archive: ['M3 3h18v5H3zM5 8v13h14V8M10 12h4'], menu: ['M3 6h18M3 12h18M3 18h18'],
  spark: ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z'], link: ['m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0'],
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name].map((path, index) => <path key={index} d={path} />)}</svg>;
}
