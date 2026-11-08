/** Small, consistent outline icons; decorative unless their control supplies a label. */
export function icon(name, size = 20) {
  const paths = {
    star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9Z"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/><circle cx="12" cy="12" r="10"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v1"/>',
    tray: '<path d="m5 4-3 10v6h20v-6L19 4ZM2 14h5l2 3h6l2-3h5"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    play: '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16m10-16v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
    tv: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 22h8"/>',
    unlink: '<path d="m9 15 6-6M8 5l1-1a5 5 0 0 1 7 7l-1 1M9 12l-1 1a5 5 0 0 0 7 7l1-1M3 3l18 18"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.compass}</svg>`;
}
