/* ========================================
   uvacSIP Web - Identificador de Llamadas
   ========================================
   Identifica el país de un número telefónico
   y devuelve nombre + bandera SVG circular.

   Uso:
     const info = UvacCallerID.identify('5212295125192');
     // → { country: 'México', flagSvg: '<svg...>', formatted: '+52 229 512 5192', isInternal: false }

     const info = UvacCallerID.identify('2042');
     // → { country: 'UVAC interna', flagSvg: '<svg...>', formatted: '2042', isInternal: true }

   NO requiere internet. Toda la base de datos está embebida.
   ======================================== */

const UvacCallerID = (function () {
    'use strict';

    // ============================================================
    // BASE DE DATOS DE PAÍSES
    // Cada país: { code, name, length (longitudes válidas del número
    //   nacional después del código de país, sin contar el código) }
    //
    // Ordenado de PREFIJOS MÁS LARGOS a más cortos para que el matching
    // sea correcto (ej. +52 México antes que +5 que no existe pero
    // +1 EE.UU./Canadá antes que +1242 Bahamas, etc.)
    // ============================================================
    const COUNTRIES = [
        // 4 dígitos
        { code: '1242', name: 'Bahamas' },
        { code: '1246', name: 'Barbados' },
        { code: '1264', name: 'Anguila' },
        { code: '1268', name: 'Antigua y Barbuda' },
        { code: '1284', name: 'Islas Vírgenes Británicas' },
        { code: '1340', name: 'Islas Vírgenes EE.UU.' },
        { code: '1345', name: 'Islas Caimán' },
        { code: '1441', name: 'Bermudas' },
        { code: '1473', name: 'Granada' },
        { code: '1649', name: 'Islas Turcas y Caicos' },
        { code: '1664', name: 'Montserrat' },
        { code: '1670', name: 'Islas Marianas del Norte' },
        { code: '1671', name: 'Guam' },
        { code: '1684', name: 'Samoa Americana' },
        { code: '1721', name: 'San Martín' },
        { code: '1758', name: 'Santa Lucía' },
        { code: '1767', name: 'Dominica' },
        { code: '1784', name: 'San Vicente y las Granadinas' },
        { code: '1787', name: 'Puerto Rico' },
        { code: '1809', name: 'República Dominicana' },
        { code: '1829', name: 'República Dominicana' },
        { code: '1849', name: 'República Dominicana' },
        { code: '1868', name: 'Trinidad y Tobago' },
        { code: '1869', name: 'San Cristóbal y Nieves' },
        { code: '1876', name: 'Jamaica' },
        { code: '1939', name: 'Puerto Rico' },

        // 3 dígitos
        { code: '212', name: 'Marruecos' },
        { code: '213', name: 'Argelia' },
        { code: '216', name: 'Túnez' },
        { code: '218', name: 'Libia' },
        { code: '220', name: 'Gambia' },
        { code: '221', name: 'Senegal' },
        { code: '222', name: 'Mauritania' },
        { code: '223', name: 'Malí' },
        { code: '224', name: 'Guinea' },
        { code: '225', name: 'Costa de Marfil' },
        { code: '226', name: 'Burkina Faso' },
        { code: '227', name: 'Níger' },
        { code: '228', name: 'Togo' },
        { code: '229', name: 'Benín' },
        { code: '230', name: 'Mauricio' },
        { code: '231', name: 'Liberia' },
        { code: '232', name: 'Sierra Leona' },
        { code: '233', name: 'Ghana' },
        { code: '234', name: 'Nigeria' },
        { code: '235', name: 'Chad' },
        { code: '236', name: 'República Centroafricana' },
        { code: '237', name: 'Camerún' },
        { code: '238', name: 'Cabo Verde' },
        { code: '239', name: 'Santo Tomé y Príncipe' },
        { code: '240', name: 'Guinea Ecuatorial' },
        { code: '241', name: 'Gabón' },
        { code: '242', name: 'Congo' },
        { code: '243', name: 'República Democrática del Congo' },
        { code: '244', name: 'Angola' },
        { code: '245', name: 'Guinea-Bisáu' },
        { code: '248', name: 'Seychelles' },
        { code: '249', name: 'Sudán' },
        { code: '250', name: 'Ruanda' },
        { code: '251', name: 'Etiopía' },
        { code: '252', name: 'Somalia' },
        { code: '253', name: 'Yibuti' },
        { code: '254', name: 'Kenia' },
        { code: '255', name: 'Tanzania' },
        { code: '256', name: 'Uganda' },
        { code: '257', name: 'Burundi' },
        { code: '258', name: 'Mozambique' },
        { code: '260', name: 'Zambia' },
        { code: '261', name: 'Madagascar' },
        { code: '262', name: 'Reunión' },
        { code: '263', name: 'Zimbabue' },
        { code: '264', name: 'Namibia' },
        { code: '265', name: 'Malaui' },
        { code: '266', name: 'Lesoto' },
        { code: '267', name: 'Botsuana' },
        { code: '268', name: 'Esuatini' },
        { code: '269', name: 'Comoras' },
        { code: '297', name: 'Aruba' },
        { code: '298', name: 'Islas Feroe' },
        { code: '299', name: 'Groenlandia' },
        { code: '350', name: 'Gibraltar' },
        { code: '351', name: 'Portugal' },
        { code: '352', name: 'Luxemburgo' },
        { code: '353', name: 'Irlanda' },
        { code: '354', name: 'Islandia' },
        { code: '355', name: 'Albania' },
        { code: '356', name: 'Malta' },
        { code: '357', name: 'Chipre' },
        { code: '358', name: 'Finlandia' },
        { code: '359', name: 'Bulgaria' },
        { code: '370', name: 'Lituania' },
        { code: '371', name: 'Letonia' },
        { code: '372', name: 'Estonia' },
        { code: '373', name: 'Moldavia' },
        { code: '374', name: 'Armenia' },
        { code: '375', name: 'Bielorrusia' },
        { code: '376', name: 'Andorra' },
        { code: '377', name: 'Mónaco' },
        { code: '378', name: 'San Marino' },
        { code: '380', name: 'Ucrania' },
        { code: '381', name: 'Serbia' },
        { code: '382', name: 'Montenegro' },
        { code: '385', name: 'Croacia' },
        { code: '386', name: 'Eslovenia' },
        { code: '387', name: 'Bosnia y Herzegovina' },
        { code: '389', name: 'Macedonia del Norte' },
        { code: '420', name: 'República Checa' },
        { code: '421', name: 'Eslovaquia' },
        { code: '423', name: 'Liechtenstein' },
        { code: '500', name: 'Islas Malvinas' },
        { code: '501', name: 'Belice' },
        { code: '502', name: 'Guatemala' },
        { code: '503', name: 'El Salvador' },
        { code: '504', name: 'Honduras' },
        { code: '505', name: 'Nicaragua' },
        { code: '506', name: 'Costa Rica' },
        { code: '507', name: 'Panamá' },
        { code: '509', name: 'Haití' },
        { code: '590', name: 'Guadalupe' },
        { code: '591', name: 'Bolivia' },
        { code: '592', name: 'Guyana' },
        { code: '593', name: 'Ecuador' },
        { code: '594', name: 'Guayana Francesa' },
        { code: '595', name: 'Paraguay' },
        { code: '596', name: 'Martinica' },
        { code: '597', name: 'Surinam' },
        { code: '598', name: 'Uruguay' },
        { code: '599', name: 'Curazao' },
        { code: '670', name: 'Timor Oriental' },
        { code: '673', name: 'Brunéi' },
        { code: '674', name: 'Nauru' },
        { code: '675', name: 'Papúa Nueva Guinea' },
        { code: '676', name: 'Tonga' },
        { code: '677', name: 'Islas Salomón' },
        { code: '678', name: 'Vanuatu' },
        { code: '679', name: 'Fiyi' },
        { code: '680', name: 'Palaos' },
        { code: '681', name: 'Wallis y Futuna' },
        { code: '682', name: 'Islas Cook' },
        { code: '683', name: 'Niue' },
        { code: '685', name: 'Samoa' },
        { code: '686', name: 'Kiribati' },
        { code: '687', name: 'Nueva Caledonia' },
        { code: '688', name: 'Tuvalu' },
        { code: '689', name: 'Polinesia Francesa' },
        { code: '690', name: 'Tokelau' },
        { code: '691', name: 'Micronesia' },
        { code: '692', name: 'Islas Marshall' },
        { code: '850', name: 'Corea del Norte' },
        { code: '852', name: 'Hong Kong' },
        { code: '853', name: 'Macao' },
        { code: '855', name: 'Camboya' },
        { code: '856', name: 'Laos' },
        { code: '880', name: 'Bangladés' },
        { code: '886', name: 'Taiwán' },
        { code: '960', name: 'Maldivas' },
        { code: '961', name: 'Líbano' },
        { code: '962', name: 'Jordania' },
        { code: '963', name: 'Siria' },
        { code: '964', name: 'Irak' },
        { code: '965', name: 'Kuwait' },
        { code: '966', name: 'Arabia Saudita' },
        { code: '967', name: 'Yemen' },
        { code: '968', name: 'Omán' },
        { code: '970', name: 'Palestina' },
        { code: '971', name: 'Emiratos Árabes Unidos' },
        { code: '972', name: 'Israel' },
        { code: '973', name: 'Baréin' },
        { code: '974', name: 'Catar' },
        { code: '975', name: 'Bután' },
        { code: '976', name: 'Mongolia' },
        { code: '977', name: 'Nepal' },
        { code: '992', name: 'Tayikistán' },
        { code: '993', name: 'Turkmenistán' },
        { code: '994', name: 'Azerbaiyán' },
        { code: '995', name: 'Georgia' },
        { code: '996', name: 'Kirguistán' },
        { code: '998', name: 'Uzbekistán' },

        // 2 dígitos
        { code: '20', name: 'Egipto' },
        { code: '27', name: 'Sudáfrica' },
        { code: '30', name: 'Grecia' },
        { code: '31', name: 'Países Bajos' },
        { code: '32', name: 'Bélgica' },
        { code: '33', name: 'Francia' },
        { code: '34', name: 'España' },
        { code: '36', name: 'Hungría' },
        { code: '39', name: 'Italia' },
        { code: '40', name: 'Rumania' },
        { code: '41', name: 'Suiza' },
        { code: '43', name: 'Austria' },
        { code: '44', name: 'Reino Unido' },
        { code: '45', name: 'Dinamarca' },
        { code: '46', name: 'Suecia' },
        { code: '47', name: 'Noruega' },
        { code: '48', name: 'Polonia' },
        { code: '49', name: 'Alemania' },
        { code: '51', name: 'Perú' },
        { code: '52', name: 'México' },
        { code: '53', name: 'Cuba' },
        { code: '54', name: 'Argentina' },
        { code: '55', name: 'Brasil' },
        { code: '56', name: 'Chile' },
        { code: '57', name: 'Colombia' },
        { code: '58', name: 'Venezuela' },
        { code: '60', name: 'Malasia' },
        { code: '61', name: 'Australia' },
        { code: '62', name: 'Indonesia' },
        { code: '63', name: 'Filipinas' },
        { code: '64', name: 'Nueva Zelanda' },
        { code: '65', name: 'Singapur' },
        { code: '66', name: 'Tailandia' },
        { code: '81', name: 'Japón' },
        { code: '82', name: 'Corea del Sur' },
        { code: '84', name: 'Vietnam' },
        { code: '86', name: 'China' },
        { code: '90', name: 'Turquía' },
        { code: '91', name: 'India' },
        { code: '92', name: 'Pakistán' },
        { code: '93', name: 'Afganistán' },
        { code: '94', name: 'Sri Lanka' },
        { code: '95', name: 'Birmania' },
        { code: '98', name: 'Irán' },

        // 1 dígito
        { code: '1', name: 'Estados Unidos' },  // También Canadá - se diferencia por NPA pero ambos comparten
        { code: '7', name: 'Rusia' }
    ];

    // ============================================================
    // BANDERAS SVG (inline, sin dependencias externas)
    // Solo las más comunes para UVAC; el resto usa "globo terráqueo".
    // Cada bandera es un SVG circular de 24x24.
    // ============================================================
    const FLAGS = {
        'México': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-mx"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-mx)"><rect x="0" y="0" width="8" height="24" fill="#006847"/><rect x="8" y="0" width="8" height="24" fill="#FFFFFF"/><rect x="16" y="0" width="8" height="24" fill="#CE1126"/></g></svg>',

        'Estados Unidos': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-us"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-us)"><rect width="24" height="24" fill="#FFFFFF"/><rect y="0" width="24" height="1.85" fill="#B22234"/><rect y="3.69" width="24" height="1.85" fill="#B22234"/><rect y="7.38" width="24" height="1.85" fill="#B22234"/><rect y="11.08" width="24" height="1.85" fill="#B22234"/><rect y="14.77" width="24" height="1.85" fill="#B22234"/><rect y="18.46" width="24" height="1.85" fill="#B22234"/><rect y="22.15" width="24" height="1.85" fill="#B22234"/><rect width="10" height="13" fill="#3C3B6E"/></g></svg>',

        'España': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-es"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-es)"><rect width="24" height="6" fill="#AA151B"/><rect y="6" width="24" height="12" fill="#F1BF00"/><rect y="18" width="24" height="6" fill="#AA151B"/></g></svg>',

        'Colombia': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-co"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-co)"><rect width="24" height="12" fill="#FCD116"/><rect y="12" width="24" height="6" fill="#003893"/><rect y="18" width="24" height="6" fill="#CE1126"/></g></svg>',

        'Argentina': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-ar"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-ar)"><rect width="24" height="8" fill="#74ACDF"/><rect y="8" width="24" height="8" fill="#FFFFFF"/><rect y="16" width="24" height="8" fill="#74ACDF"/></g></svg>',

        'Chile': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-cl"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-cl)"><rect width="24" height="12" fill="#FFFFFF"/><rect y="12" width="24" height="12" fill="#D52B1E"/><rect width="9" height="12" fill="#0039A6"/></g></svg>',

        'Perú': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-pe"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-pe)"><rect x="0" y="0" width="8" height="24" fill="#D91023"/><rect x="8" y="0" width="8" height="24" fill="#FFFFFF"/><rect x="16" y="0" width="8" height="24" fill="#D91023"/></g></svg>',

        'Venezuela': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-ve"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-ve)"><rect width="24" height="8" fill="#FCE300"/><rect y="8" width="24" height="8" fill="#0033A0"/><rect y="16" width="24" height="8" fill="#CF142B"/></g></svg>',

        'Brasil': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-br"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-br)"><rect width="24" height="24" fill="#009C3B"/><polygon points="12,4 20,12 12,20 4,12" fill="#FFDF00"/><circle cx="12" cy="12" r="3.5" fill="#002776"/></g></svg>',

        'Cuba': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-cu"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-cu)"><rect width="24" height="4.8" fill="#002A8F"/><rect y="4.8" width="24" height="4.8" fill="#FFFFFF"/><rect y="9.6" width="24" height="4.8" fill="#002A8F"/><rect y="14.4" width="24" height="4.8" fill="#FFFFFF"/><rect y="19.2" width="24" height="4.8" fill="#002A8F"/><polygon points="0,0 11,12 0,24" fill="#CF142B"/></g></svg>',

        'Guatemala': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-gt"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-gt)"><rect x="0" y="0" width="8" height="24" fill="#4997D0"/><rect x="8" y="0" width="8" height="24" fill="#FFFFFF"/><rect x="16" y="0" width="8" height="24" fill="#4997D0"/></g></svg>',

        'Honduras': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-hn"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-hn)"><rect width="24" height="8" fill="#0073CF"/><rect y="8" width="24" height="8" fill="#FFFFFF"/><rect y="16" width="24" height="8" fill="#0073CF"/></g></svg>',

        'El Salvador': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-sv"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-sv)"><rect width="24" height="8" fill="#0047AB"/><rect y="8" width="24" height="8" fill="#FFFFFF"/><rect y="16" width="24" height="8" fill="#0047AB"/></g></svg>',

        'Nicaragua': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-ni"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-ni)"><rect width="24" height="8" fill="#0067C6"/><rect y="8" width="24" height="8" fill="#FFFFFF"/><rect y="16" width="24" height="8" fill="#0067C6"/></g></svg>',

        'Costa Rica': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-cr"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-cr)"><rect width="24" height="24" fill="#FFFFFF"/><rect y="0" width="24" height="4.5" fill="#0033A0"/><rect y="19.5" width="24" height="4.5" fill="#0033A0"/><rect y="9" width="24" height="6" fill="#CE1126"/></g></svg>',

        'Panamá': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-pa"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-pa)"><rect width="12" height="12" fill="#FFFFFF"/><rect x="12" y="0" width="12" height="12" fill="#D21034"/><rect x="0" y="12" width="12" height="12" fill="#005AA7"/><rect x="12" y="12" width="12" height="12" fill="#FFFFFF"/></g></svg>',

        'Ecuador': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-ec"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-ec)"><rect width="24" height="12" fill="#FFDD00"/><rect y="12" width="24" height="6" fill="#0033A0"/><rect y="18" width="24" height="6" fill="#CE1126"/></g></svg>',

        'Bolivia': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-bo"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-bo)"><rect width="24" height="8" fill="#D52B1E"/><rect y="8" width="24" height="8" fill="#F9E300"/><rect y="16" width="24" height="8" fill="#007A33"/></g></svg>',

        'Paraguay': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-py"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-py)"><rect width="24" height="8" fill="#D52B1E"/><rect y="8" width="24" height="8" fill="#FFFFFF"/><rect y="16" width="24" height="8" fill="#0038A8"/></g></svg>',

        'Uruguay': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-uy"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-uy)"><rect width="24" height="24" fill="#FFFFFF"/><rect y="2.7" width="24" height="2.7" fill="#0038A8"/><rect y="8.1" width="24" height="2.7" fill="#0038A8"/><rect y="13.5" width="24" height="2.7" fill="#0038A8"/><rect y="18.9" width="24" height="2.7" fill="#0038A8"/><rect width="11" height="13.5" fill="#FFFFFF"/></g></svg>',

        'Reino Unido': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-gb"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-gb)"><rect width="24" height="24" fill="#012169"/><path d="M0,0 L24,24 M24,0 L0,24" stroke="#FFFFFF" stroke-width="3"/><path d="M0,0 L24,24 M24,0 L0,24" stroke="#C8102E" stroke-width="1.5"/><path d="M12,0 V24 M0,12 H24" stroke="#FFFFFF" stroke-width="4"/><path d="M12,0 V24 M0,12 H24" stroke="#C8102E" stroke-width="2"/></g></svg>',

        'Francia': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-fr"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-fr)"><rect x="0" y="0" width="8" height="24" fill="#002654"/><rect x="8" y="0" width="8" height="24" fill="#FFFFFF"/><rect x="16" y="0" width="8" height="24" fill="#ED2939"/></g></svg>',

        'Alemania': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-de"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-de)"><rect width="24" height="8" fill="#000000"/><rect y="8" width="24" height="8" fill="#DD0000"/><rect y="16" width="24" height="8" fill="#FFCE00"/></g></svg>',

        'Italia': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-it"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-it)"><rect x="0" y="0" width="8" height="24" fill="#009246"/><rect x="8" y="0" width="8" height="24" fill="#FFFFFF"/><rect x="16" y="0" width="8" height="24" fill="#CE2B37"/></g></svg>',

        'Portugal': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-pt"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-pt)"><rect width="24" height="24" fill="#FF0000"/><rect width="10" height="24" fill="#006600"/></g></svg>',

        'China': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-cn"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-cn)"><rect width="24" height="24" fill="#DE2910"/><polygon points="5,5 6,7.5 8.5,7.5 6.5,9 7.5,11.5 5,10 2.5,11.5 3.5,9 1.5,7.5 4,7.5" fill="#FFDE00"/></g></svg>',

        'Japón': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-jp"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-jp)"><rect width="24" height="24" fill="#FFFFFF"/><circle cx="12" cy="12" r="6" fill="#BC002D"/></g></svg>',

        'Rusia': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="f-ru"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#f-ru)"><rect width="24" height="8" fill="#FFFFFF"/><rect y="8" width="24" height="8" fill="#0039A6"/><rect y="16" width="24" height="8" fill="#D52B1E"/></g></svg>'
    };

    // Bandera genérica (globo terráqueo) cuando el país no está en FLAGS
    const FLAG_GENERIC = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="12" fill="#4A90E2"/><path d="M12,2 C6.48,2 2,6.48 2,12 C2,17.52 6.48,22 12,22 C17.52,22 22,17.52 22,12 C22,6.48 17.52,2 12,2 Z M12,4 C13.06,4 14.06,4.21 14.97,4.59 L13.5,6 L12,5 L10.5,7 L8.5,5.5 C9.55,4.55 10.7,4 12,4 Z M4,12 C4,10.4 4.47,8.91 5.28,7.66 L7,9 L8,11 L11,11 L10,13 L11,14 L9,16 L6,15 C4.74,14.16 4,13.13 4,12 Z M12,20 C9.5,20 7.28,18.84 5.87,17.05 L8,17 L10,15 L13,16 L15,15 L17,17 C15.66,18.84 13.93,20 12,20 Z M19.5,15 L17.5,13.5 L15,14.5 L14,12 L16,10 L18,11 L20,9 C20,9 19.7,13.5 19.5,15 Z" fill="#FFFFFF" opacity="0.8"/></svg>';

    // Bandera para extensiones internas (edificio UVAC)
    const FLAG_INTERNAL = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="12" fill="#1e4d8c"/><path d="M7,7 L7,18 L11,18 L11,15 L13,15 L13,18 L17,18 L17,7 L7,7 Z M9,9 L10,9 L10,10 L9,10 L9,9 Z M11,9 L12,9 L12,10 L11,10 L11,9 Z M13,9 L14,9 L14,10 L13,10 L13,9 Z M9,11 L10,11 L10,12 L9,12 L9,11 Z M11,11 L12,11 L12,12 L11,12 L11,11 Z M13,11 L14,11 L14,12 L13,12 L13,11 Z M9,13 L10,13 L10,14 L9,14 L9,13 Z M13,13 L14,13 L14,14 L13,14 L13,13 Z" fill="#FFFFFF"/></svg>';

    /**
     * Limpia un número quitando todo excepto dígitos.
     * También quita el "+" inicial si existe.
     */
    function _clean(number) {
        if (number === null || number === undefined) return '';
        return String(number).replace(/[^\d]/g, '');
    }

    /**
     * Determina si un número es una extensión interna.
     * Reglas:
     *  - 4 dígitos o menos → extensión interna
     *  - Empieza con "*" o "#" → código de servicio (también interno)
     */
    function _isInternalExtension(rawNumber) {
        if (!rawNumber) return false;
        const str = String(rawNumber).trim();
        if (str.startsWith('*') || str.startsWith('#')) return true;
        const clean = _clean(rawNumber);
        return clean.length > 0 && clean.length <= 4;
    }

    /**
     * Formatea un número con espacios para mejor lectura.
     * Ejemplo: "5212295125192" + país "México" (52)
     *   → "+52 229 512 5192"
     */
    function _format(cleanNumber, countryCode) {
        if (!cleanNumber) return '';

        // Si no se identificó país, devolver con "+" y espacios cada 3 dígitos
        if (!countryCode) {
            return '+' + cleanNumber.replace(/(\d{3})/g, '$1 ').trim();
        }

        const national = cleanNumber.substring(countryCode.length);

        // Agrupar el número nacional en bloques legibles (3-4-4 o similar)
        let grouped = '';
        if (national.length <= 7) {
            // Ejemplo: 5125192 → 512 5192
            grouped = national.replace(/(\d{3})(\d+)/, '$1 $2');
        } else if (national.length === 10) {
            // Ejemplo: 2295125192 (LADA + 7 dígitos) → 229 512 5192
            grouped = national.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
        } else {
            // Genérico: agrupar de 3 en 3
            grouped = national.replace(/(\d{3})/g, '$1 ').trim();
        }

        return '+' + countryCode + ' ' + grouped;
    }

    /**
     * Identificación principal.
     * Devuelve siempre un objeto, nunca null.
     *
     * @param {string} rawNumber - número crudo como lo tecleó/recibió el usuario
     * @returns {object} { country, flagSvg, formatted, isInternal, isUnknown }
     */
    function identify(rawNumber) {
        // Caso 1: vacío
        if (!rawNumber || String(rawNumber).trim() === '') {
            return {
                country: '',
                flagSvg: FLAG_GENERIC,
                formatted: '',
                isInternal: false,
                isUnknown: true
            };
        }

        // Caso 2: extensión interna
        if (_isInternalExtension(rawNumber)) {
            return {
                country: 'UVAC interna',
                flagSvg: FLAG_INTERNAL,
                formatted: String(rawNumber),
                isInternal: true,
                isUnknown: false
            };
        }

        // Caso 3: número externo, buscar país
        const clean = _clean(rawNumber);

        // OPTIMIZACIÓN UVAC: si el número tiene exactamente 10 dígitos
        // sin código de país, es 99% un número mexicano (la LADA es de 2-3 dígitos
        // y el suscriptor de 7-8). Esto evita falsos positivos con países pequeños
        // como Benín (229) que coincide con la LADA de Veracruz.
        if (clean.length === 10) {
            return {
                country: 'México',
                flagSvg: FLAGS['México'],
                formatted: _format('52' + clean, '52'),
                isInternal: false,
                isUnknown: false
            };
        }

        // OPTIMIZACIÓN UVAC: número mexicano con prefijo "1" móvil antiguo (52 + 1 + 10 dígitos = 13)
        // Asterisk a veces normaliza así. Lo tratamos como mexicano y quitamos el 1.
        if (clean.length === 13 && clean.startsWith('521')) {
            const normalized = '52' + clean.substring(3);
            return {
                country: 'México',
                flagSvg: FLAGS['México'],
                formatted: _format(normalized, '52'),
                isInternal: false,
                isUnknown: false
            };
        }

        // Probar cada código de país (ya están ordenados por longitud descendente)
        for (let i = 0; i < COUNTRIES.length; i++) {
            const c = COUNTRIES[i];
            if (clean.startsWith(c.code) && clean.length > c.code.length) {
                return {
                    country: c.name,
                    flagSvg: FLAGS[c.name] || FLAG_GENERIC,
                    formatted: _format(clean, c.code),
                    isInternal: false,
                    isUnknown: false
                };
            }
        }

        // Caso 5: desconocido
        return {
            country: 'Desconocido',
            flagSvg: FLAG_GENERIC,
            formatted: '+' + clean,
            isInternal: false,
            isUnknown: true
        };
    }

    /**
     * Helper: genera el HTML de bandera + texto para insertar en un avatar.
     * El SVG ya viene con clip-path circular, solo lo dimensionamos.
     */
    function renderFlagAvatar(info, size) {
        size = size || 36;
        return '<div style="width:' + size + 'px;height:' + size + 'px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border-radius:50%;flex-shrink:0;">' +
               info.flagSvg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" ') +
               '</div>';
    }

    // API pública
    return {
        identify: identify,
        renderFlagAvatar: renderFlagAvatar
    };
})();
