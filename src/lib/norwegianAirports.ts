export type NorwegianAirport = { code: string; name: string };

// Avinor + Svalbard (IATA). Praktisk liste for widget-velger.
// Kilde: kjente norske lufthavner (IATA-koder).
const UNSORTED_NORWEGIAN_AIRPORTS: NorwegianAirport[] = [
  { code: "AES", name: "Ålesund lufthavn Vigra" },
  { code: "ALF", name: "Alta lufthavn" },
  { code: "ANX", name: "Andøya lufthavn Andenes" },
  { code: "BDU", name: "Bardufoss lufthavn" },
  { code: "BGO", name: "Bergen lufthavn Flesland" },
  { code: "BJF", name: "Båtsfjord lufthavn" },
  { code: "BVG", name: "Berlevåg lufthavn" },
  { code: "BOO", name: "Bodø lufthavn" },
  { code: "BNN", name: "Brønnøysund lufthavn Brønnøy" },
  { code: "DLD", name: "Geilo lufthavn Dagali" },
  { code: "EVE", name: "Harstad/Narvik lufthavn Evenes" },
  { code: "FAG", name: "Fagernes lufthavn Leirin" },
  { code: "FDE", name: "Førde lufthavn Bringeland" },
  { code: "FRO", name: "Florø lufthavn" },
  { code: "GLL", name: "Gol lufthavn" },
  { code: "HAU", name: "Haugesund lufthavn Karmøy" },
  { code: "HFT", name: "Hammerfest lufthavn" },
  { code: "HVG", name: "Honningsvåg lufthavn Valan" },
  { code: "KKN", name: "Kirkenes lufthavn Høybuktmoen" },
  { code: "KRS", name: "Kristiansand lufthavn Kjevik" },
  { code: "KSU", name: "Kristiansund lufthavn Kvernberget" },
  { code: "LKL", name: "Lakselv lufthavn Banak" },
  { code: "LKN", name: "Leknes lufthavn" },
  { code: "LYR", name: "Svalbard lufthavn Longyear" },
  { code: "MEH", name: "Mehamn lufthavn" },
  { code: "MJF", name: "Mosjøen lufthavn Kjærstad" },
  { code: "MOL", name: "Molde lufthavn Årø" },
  { code: "MQN", name: "Mo i Rana lufthavn Røssvoll" },
  { code: "NVK", name: "Narvik lufthavn Framnes" },
  { code: "OSL", name: "Oslo lufthavn Gardermoen" },
  { code: "OSY", name: "Namsos lufthavn" },
  { code: "ORK", name: "Orland lufthavn" },
  { code: "RVK", name: "Rørvik lufthavn Ryum" },
  { code: "RRS", name: "Røros lufthavn" },
  { code: "SDN", name: "Sandane lufthavn Anda" },
  { code: "SKE", name: "Skien lufthavn Geiteryggen" },
  { code: "SKN", name: "Stokmarknes lufthavn Skagen" },
  { code: "SOJ", name: "Sørkjosen lufthavn" },
  { code: "SVG", name: "Stavanger lufthavn Sola" },
  { code: "TOS", name: "Tromsø lufthavn" },
  { code: "TRD", name: "Trondheim lufthavn Værnes" },
  { code: "VDS", name: "Vadsø lufthavn" },
  { code: "VDB", name: "Vardø lufthavn Svartnes" },
];

export const NORWEGIAN_AIRPORTS: NorwegianAirport[] = [...UNSORTED_NORWEGIAN_AIRPORTS].sort((a, b) =>
  a.name.localeCompare(b.name, "nb-NO"),
);

export const norwegianAirportLabelByCode: Record<string, string> = Object.fromEntries(
  NORWEGIAN_AIRPORTS.map((a) => [a.code, `${a.name} (${a.code})`]),
);
