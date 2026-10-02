// Player colors. Each seat picks a color; the value used depends on the
// theme so lines stay readable on paper, at night and in high contrast.

export const PALETTE = {
  blue: { name: 'Blue', paper: '#2440f0', night: '#35d4ff', contrast: '#0030d0' },
  red: { name: 'Red', paper: '#dd2738', night: '#ff4b60', contrast: '#c4001b' },
  green: { name: 'Green', paper: '#12873d', night: '#4ade80', contrast: '#006b2a' },
  gold: { name: 'Gold', paper: '#b07d00', night: '#fbbf24', contrast: '#7a5500' },
  orange: { name: 'Orange', paper: '#e07000', night: '#ffa63d', contrast: '#a84f00' },
  purple: { name: 'Purple', paper: '#7c3aed', night: '#c084fc', contrast: '#5b1fc4' },
  teal: { name: 'Teal', paper: '#0d8a8c', night: '#2dd4bf', contrast: '#006466' },
  pink: { name: 'Pink', paper: '#d0237f', night: '#f472b6', contrast: '#a1005d' },
};

export const DEFAULT_SEATS = ['blue', 'red', 'green', 'gold'];
// Based on the Okabe and Ito palette: tells apart for the common kinds of
// color blindness.
export const FRIENDLY_SEATS = ['blue', 'orange', 'pink', 'green'];

export function seatColors(settings) {
  const s = Array.isArray(settings && settings.colors) ? settings.colors : DEFAULT_SEATS;
  return [0, 1, 2, 3].map((i) => (PALETTE[s[i]] ? s[i] : DEFAULT_SEATS[i]));
}

export function colorName(settings, seat) {
  return PALETTE[seatColors(settings)[seat]].name;
}

export function seatNames(settings, n = 4) {
  return [0, 1, 2, 3].slice(0, n).map((i) => colorName(settings, i));
}

export function effectiveTheme(theme) {
  if (theme === 'paper' || theme === 'night' || theme === 'contrast') return theme;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
}

// Writes --c0..--c3 on the root element.
export function applyColors(settings) {
  const theme = effectiveTheme(settings.theme);
  const seats = seatColors(settings);
  const root = document.documentElement;
  seats.forEach((key, i) => root.style.setProperty(`--c${i}`, PALETTE[key][theme]));
}
