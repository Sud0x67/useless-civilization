import type { CSSProperties } from 'react';
const paths: Record<string, string> = {
  cube: 'm12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5',
  book: 'M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15',
  play: 'm8 5 11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  skip: 'm5 5 10 7-10 7zM19 5v14',
  'step-back': 'M5 5v14M19 5 9 12l10 7z',
  'step-forward': 'm5 5 10 7-10 7zM19 5v14',
  crown: 'm3 7 4 4 5-7 5 7 4-4-2 12H5z',
  spark: 'm12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8z',
  ban: 'M5 5l14 14M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  shuffle:
    'M3 7h4c4 0 6 10 10 10h4M17 3l4 4-4 4M3 17h4c1 0 2-1 3-2M14 9c1-1 2-2 3-2h4M17 13l4 4-4 4',
  bread: 'M5 10a4 4 0 0 1 1-8h12a4 4 0 0 1 1 8v11H5zM9 7v3M15 7v3',
  rain: 'M7 16H5a4 4 0 0 1 0-8 7 7 0 0 1 13-1 4.5 4.5 0 0 1 1 9h-1M8 18l-1 3M13 18l-1 3M18 18l-1 3',
  people:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.9M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  chat: 'M21 11a9 9 0 0 1-9 9H5l-4 3 1-7A9 9 0 1 1 21 11zM7 10h.01M12 10h.01M17 10h.01',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7z',
  heart:
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
  settings:
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  moon: 'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  target: 'M12 2v4M12 18v4M2 12h4M18 12h4M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  arrow: 'M5 12h14M14 7l5 5-5 5',
  close: 'M6 6l12 12M6 18 18 6',
  download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 17v4h16v-4',
  volume: 'M11 5 6 9H2v6h4l5 4zM15 8a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14',
  mute: 'M11 5 6 9H2v6h4l5 4zM17 9l5 6M17 15l5-6',
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
  check: 'm5 12 4 4L19 6',
  info: 'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  refresh: 'M21 3v6h-6M3 21v-6h6M4 9a8 8 0 0 1 13-5l4 5M20 15a8 8 0 0 1-13 5l-4-5',
};
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name] || paths.spark} />
    </svg>
  );
}
