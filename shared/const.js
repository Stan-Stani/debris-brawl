// Tuning shared by the server and the browser. World units are CSS pixels of the laid-out page.

export const CELL = 2;            // world px per terrain cell
export const LAYOUT_W = 1280;     // pages are laid out this wide
export const MAX_H = 3200;        // and cut off this tall
export const MIN_H = 900;

export const EMPTY = 0, SOLID = 1, TEXT = 2, RUBBLE = 3;

export const TICK = 1 / 60;
export const NET_TICKS = 2;       // server sends an update every 2 ticks (30 Hz)
export const INTERP_DELAY = 0.1;  // remote players are drawn this far in the past

export const ROUND_TIME = 300;
export const END_TIME = 8;
export const RESPAWN_TIME = 2.5;
export const SPAWN_PROTECT = 1.5;
export const MAX_PLAYERS = 8;

export const PLAYER = {
  w: 14, h: 34, hp: 100,
  run: 250, accel: 2600, airAccel: 1500,
  gravity: 1500, maxFall: 950,
  jump: 560, flip: 500,             // jump, then tap again to flip
  thrust: 2900, maxUp: 380,         // hold after the flip to fly
  fuel: 1.1, fuelRegen: 0.9,
  stepUp: 6,                        // px of rubble you walk up without jumping
  coyote: 0.08,
};

// hole = radius in px each bullet bite carves; pierce = how much terrain a bullet chews through
export const WEAPONS = [
  { id: 'pistol', name: 'Pistol', auto: false, cd: 0.18, pellets: 1, spread: 0.012, speed: 2600, dmg: 16, pierce: 5, hole: 4, range: 1.2, gun: 9 },
  { id: 'smg', name: 'SMG', auto: true, cd: 0.075, pellets: 1, spread: 0.07, speed: 2400, dmg: 8, pierce: 3, hole: 3, range: 1, gun: 12 },
  { id: 'shotgun', name: 'Shotgun', auto: false, cd: 0.7, pellets: 9, spread: 0.17, speed: 2100, dmg: 11, pierce: 3, hole: 4, range: 0.32, gun: 13 },
  { id: 'rocket', name: 'Rocket', auto: false, cd: 0.95, kind: 'rocket', pellets: 1, spread: 0, speed: 900, dmg: 75, radius: 48, gun: 15 },
  { id: 'rail', name: 'Railgun', auto: false, cd: 1.3, pellets: 1, spread: 0, speed: 7000, dmg: 70, pierce: 60, hole: 5, range: 0.5, gun: 17 },
];

export const GRENADE = { cd: 3, fuse: 1.5, speed: 650, radius: 52, dmg: 80, gravity: 1300 };
export const ROCKET_LIFE = 3;

// The new part: scoop up rubble, charge, throw it at people.
export const DEBRIS = {
  reach: 34,          // px from your chest you can scoop rubble or catch a chunk
  maxCells: 110,
  minCells: 6,
  charge: 0.75,       // seconds to a full-power throw
  minSpeed: 380, maxSpeed: 1150,
  gravity: 1300,
  dmgBase: 8, dmgPerCell: 0.42,
  hurtSpeed: 150,     // slower than this and it just bumps you
  smash: 480,         // faster than this into terrain and it bursts, cratering the page
  grabCd: 0.3,
};

export const COLORS = ['#ff4d4d', '#3fa9ff', '#ffd23f', '#5bd96a', '#c86bff', '#ff8c2e', '#3fe0d0', '#ff6bb5'];

// player flags in snapshots
export const FL_FLY = 1, FL_FLIP = 2, FL_PROT = 4, FL_CHARGE = 8;
