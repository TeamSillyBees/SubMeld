// ISO 3166-1 alpha-3 and alpha-2 pairs used by provider responses.
const countries = `
ABWAW AFGAF AGOAO AIAAI ALAAX ALBAL ANDAD AREAE ARGAR ARMAM ASMAS ATAAQ ATFTF ATGAG AUSAU AUTAT
AZEAZ BDIBI BELBE BENBJ BESBQ BFABF BGDBD BGRBG BHRBH BHSBS BIHBA BLMBL BLRBY BLZBZ BMUBM BOLBO
BRABR BRBBB BRNBN BTNBT BVTBV BWABW CAFCF CANCA CCKCC CHECH CHLCL CHNCN CIVCI CMRCM CODCD COGCG
COKCK COLCO COMKM CPVCV CRICR CUBCU CUWCW CXRCX CYMKY CYPCY CZECZ DEUDE DJIDJ DMADM DNKDK DOMDO
DZADZ ECUEC EGYEG ERIER ESHEH ESPES ESTEE ETHET FINFI FJIFJ FLKFK FRAFR FROFO FSMFM GABGA GBRGB
GEOGE GGYGG GHAGH GIBGI GINGN GLPGP GMBGM GNBGW GNQGQ GRCGR GRDGD GRLGL GTMGT GUFGF GUMGU GUYGY
HKGHK HMDHM HNDHN HRVHR HTIHT HUNHU IDNID IMNIM INDIN IOTIO IRLIE IRNIR IRQIQ ISLIS ISRIL ITAIT
JAMJM JEYJE JORJO JPNJP KAZKZ KENKE KGZKG KHMKH KIRKI KNAKN KORKR KWTKW LAOLA LBNLB LBRLR LBYLY
LCALC LIELI LKALK LSOLS LTULT LUXLU LVALV MACMO MAFMF MARMA MCOMC MDAMD MDGMG MDVMV MEXMX MHLMH
MKDMK MLIML MLTMT MMRMM MNEME MNGMN MNPMP MOZMZ MRTMR MSRMS MTQMQ MUSMU MWIMW MYSMY MYTYT NAMNA
NCLNC NERNE NFKNF NGANG NICNI NIUNU NLDNL NORNO NPLNP NRUNR NZLNZ OMNOM PAKPK PANPA PCNPN PERPE
PHLPH PLWPW PNGPG POLPL PRIPR PRKKP PRTPT PRYPY PSEPS PYFPF QATQA REURE ROURO RUSRU RWARW SAUSA
SDNSD SENSN SGPSG SGSGS SHNSH SJMSJ SLBSB SLESL SLVSV SMRSM SOMSO SPMPM SRBRS SSDSS STPST SURSR
SVKSK SVNSI SWESE SWZSZ SXMSX SYCSC SYRSY TCATC TCDTD TGOTG THATH TJKTJ TKLTK TKMTM TLSTL TONTO
TTOTT TUNTN TURTR TUVTV TWNTW TZATZ UGAUG UKRUA UMIUM URYUY USAUS UZBUZ VATVA VCTVC VENVE VGBVG
VIRVI VNMVN VUTVU WLFWF WSMWS YEMYE ZAFZA ZMBZM ZWEZW
`.trim().split(/\s+/)
const codes = new Map(countries.map(pair => [pair.slice(0, 3), pair.slice(3)]))
const alpha2 = new Set([...codes.values(), 'XK'])
export function countryCode(value: unknown) {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return alpha2.has(code) ? code : codes.get(code) ?? null
}

const enRegionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const locationAliases = new Map<string, string>()
function normalizeLocationToken(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'").replace(/&/g, 'and')
    .replace(/\s*\([^)]*\)/g, '').replace(/\s+sar\s+china$/i, '').replace(/^the\s+/i, '').replace(/\s+/g, ' ').trim().toLowerCase()
}
for (const code of alpha2) {
  const name = enRegionNames.of(code)
  if (name) locationAliases.set(normalizeLocationToken(name), code)
}
for (const [alias, code] of Object.entries({
  uk: 'GB', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', uae: 'AE', 'united states of america': 'US',
  'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  macau: 'MO', 'macao sar': 'MO', 'hong kong sar': 'HK', turkey: 'TR', 'czech republic': 'CZ',
  'ivory coast': 'CI', 'cape verde': 'CV', palestine: 'PS', 'east timor': 'TL', swaziland: 'SZ',
  'the bahamas': 'BS', 'the gambia': 'GM', burma: 'MM', 'congo - kinshasa': 'CD',
  'democratic republic of the congo': 'CD', 'congo - brazzaville': 'CG', 'republic of the congo': 'CG',
  'republic of korea': 'KR', 'south korea': 'KR', 'north korea': 'KP', 'russian federation': 'RU',
  'viet nam': 'VN', 'taiwan, province of china': 'TW', "lao people's democratic republic": 'LA',
  'syrian arab republic': 'SY', 'iran, islamic republic of': 'IR', 'bolivia, plurinational state of': 'BO',
  'venezuela, bolivarian republic of': 'VE', 'tanzania, united republic of': 'TZ', 'moldova, republic of': 'MD',
  'brunei darussalam': 'BN', 'u.s. virgin islands': 'VI', 'british virgin islands': 'VG',
  'falkland islands': 'FK', 'pitcairn islands': 'PN', 'vatican city': 'VA', 'holy see': 'VA',
  'united states minor outlying islands': 'UM', 'u.s. outlying islands': 'UM',
  'south georgia and the south sandwich islands': 'GS', 'heard island and mcdonald islands': 'HM',
  'saint helena, ascension and tristan da cunha': 'SH', 'sao tome and principe': 'ST',
  'saint barthelemy': 'BL', 'saint kitts and nevis': 'KN', 'saint lucia': 'LC', 'saint martin': 'MF',
  'saint pierre and miquelon': 'PM', 'saint vincent and the grenadines': 'VC',
  'caribbean netherlands': 'BQ', 'aland islands': 'AX', kosovo: 'XK',
})) {
  locationAliases.set(normalizeLocationToken(alias), code)
}
export function countryFromLocation(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const direct = countryCode(value)
  if (direct) return direct
  const normalized = normalizeLocationToken(value)
  if (!normalized) return null
  const exact = locationAliases.get(normalized)
  if (exact) return exact
  const lastSegment = value.split(',').at(-1)
  if (lastSegment && lastSegment !== value) {
    return locationAliases.get(normalizeLocationToken(lastSegment)) ?? null
  }
  return null
}

// Consumer availability, checked 2026-11-23 / 2026-11-25. Compare only with the provider's own region signal.
// https://help.openai.com/en/articles/7947663
// https://support.google.com/gemini/answer/13575153 (personal accounts)
// https://antigravity.google/docs/faq#what-is-google-antigravitys-geographical-availability
// https://ai.google.dev/gemini-api/docs/available-regions
export const unlistedRegions = {
  ChatGPT: new Set('AI AQ AS BQ BV BY CC CK CN CU CW CX EH FK GG GI GS GU HK HM IM IO IR JE KP MO MP MS NF NU PN PR RU SX SY TC TK UM VE VG VI XK'.split(' ')),
  Gemini: new Set('AF BV BY CN CU IR KP RU SY'.split(' ')),
  Antigravity: new Set('AD AF AX BV BY CN CU GF GP HK IR KP MC MD MF MM MO MQ PF RE RU SJ SM SX SY TF VA YT'.split(' ')),
}
