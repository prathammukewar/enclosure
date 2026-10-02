// Site settings that don't belong to any one player.
export const CONFIG = {
  // Privacy-friendly visitor counts with GoatCounter (https://www.goatcounter.com).
  // Off until a site code is filled in, for example 'enclosure' for
  // https://enclosure.goatcounter.com. No cookies, no personal data.
  goatcounter: '',
};

export function startAnalytics() {
  if (!CONFIG.goatcounter) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${CONFIG.goatcounter}.goatcounter.com/count`;
  s.dataset.goatcounterSettings = JSON.stringify({ allow_local: false });
  document.head.appendChild(s);
}
