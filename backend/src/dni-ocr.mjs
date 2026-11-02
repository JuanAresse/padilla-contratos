const SPANISH_UPPERCASE = "A-ZÁÉÍÓÚÜÑ";
const SPANISH_LETTERS = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";

export function parseDniText(text) {
  const rawText = String(text || "");
  const lines = rawText
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean);
  const normalized = lines.join("\n");

  const surname = findLabelValue(lines, ["apellido", "apelido", "surname", "surnam", "sumame", "surnarne"]);
  const names = findLabelValue(lines, ["nombres", "nombre", "name"], ["apellido", "apelido", "surname", "sumame", "surnarne"]);
  const fullLabelName = findLabelValue(lines, ["apellido y nombre", "nombre y apellido"]);
  const mrzName = parseMrzName(lines);
  const mrzGivenNames = parseMrzGivenNames(lines);
  const fallbackName = findUppercaseNameLine(lines);
  const dni = extractDni(normalized);
  const explicitCuil = extractCuil(normalized);
  const sex = extractSex(normalized);
  const validExplicitCuil = validateArgentineCuil(explicitCuil) ? explicitCuil : "";
  const hasMrz = Boolean(mrzName) || lines.some((line) => /<+[A-Z]/i.test(line));
  const fullName = normalizeName(hasMrz ? (mrzName || fullLabelName || combineName(names || (surname ? mrzGivenNames : ""), surname) || fallbackName) : (fullLabelName || combineName(names, surname) || mrzName || fallbackName));
  const cuil = validExplicitCuil || calculateArgentineCuil(dni, sex);
  const birthDate = extractBirthDateV2(normalized);
  const hasPersonalData = Boolean(fullName || dni || cuil || birthDate);

  return {
    fullName,
    dni,
    cuil,
    birthDate,
    nationality: hasPersonalData ? extractNationality(normalized) : "",
  };
}

export function hasUsefulDniFields(fields = {}) {
  return Boolean(fields.dni || fields.cuil);
}

export function validateDniRead(fields = {}) {
  const dni = onlyDigits(fields.dni);
  const cuil = onlyDigits(fields.cuil);
  const warnings = [];
  if (!/^\d{7,8}$/.test(dni)) warnings.push("El DNI leido no tiene 7 u 8 digitos validos.");

  const cuilMatchesDni = validateArgentineCuil(cuil) && cuil.slice(2, 10) === dni.padStart(8, "0");
  if (cuil && !cuilMatchesDni) warnings.push("El CUIL leido no coincide con el DNI.");

  const hasIdentityContext = looksLikePersonName(fields.fullName) && Boolean(fields.birthDate || fields.nationality);
  const ok = /^\d{7,8}$/.test(dni) && (cuilMatchesDni || hasIdentityContext);
  if (!ok && /^\d{7,8}$/.test(dni)) warnings.push("La lectura quedo parcial y requiere carga manual.");

  return { ok, warnings };
}

export function analyzeDniText(text, source = "ocr") {
  const fields = parseDniText(text);
  const documentType = detectDniDocumentType(text);
  const warnings = [];
  const rawCuil = extractCuil(String(text || ""));
  if (rawCuil && !validateArgentineCuil(rawCuil) && fields.cuil) {
    warnings.push("El CUIL impreso no paso la validacion; se calculo un CUIL valido desde el DNI y el sexo.");
  } else if (rawCuil && !validateArgentineCuil(rawCuil)) {
    warnings.push("El CUIL leido no paso la validacion y fue descartado.");
  }

  return {
    fields,
    confidence: confidenceForFields(fields, source, documentType),
    warnings,
    documentType,
    source,
  };
}

export function parseDniBarcodeText(text) {
  const rawText = String(text || "");
  const fromParams = parseBarcodeUrlParams(rawText);
  const fromTokens = parseBarcodeTokens(rawText);
  const fromOcr = parseDniText(rawText);
  const fields = compactFields({
    fullName: fromParams.fullName || fromTokens.fullName || fromOcr.fullName,
    dni: fromParams.dni || fromTokens.dni || fromOcr.dni,
    cuil: fromParams.cuil || fromTokens.cuil || fromOcr.cuil,
    birthDate: fromParams.birthDate || fromTokens.birthDate || fromOcr.birthDate,
    nationality: fromParams.nationality || fromTokens.nationality || fromOcr.nationality,
  });
  const sex = fromParams.sex || fromTokens.sex || extractSex(rawText);

  if (fields.cuil && !validateArgentineCuil(fields.cuil)) fields.cuil = "";
  if (!fields.cuil) fields.cuil = calculateArgentineCuil(fields.dni, sex);
  if (!fields.nationality && (hasUsefulDniFields(fields) || /ARG|ARGENTINA/i.test(rawText))) fields.nationality = "Argentina";

  return fields;
}

export function analyzeDniBarcodeText(text) {
  const fields = parseDniBarcodeText(text);
  return {
    fields,
    confidence: confidenceForFields(fields, "barcode", "codigo"),
    warnings: [],
    documentType: "codigo",
    source: "barcode",
  };
}

export function validateArgentineCuil(value) {
  const digits = onlyDigits(value);
  if (!/^\d{11}$/.test(digits)) return false;
  const base = digits.slice(0, 10);
  const expected = calculateCuilCheckDigit(base);
  return expected !== "" && digits.endsWith(expected);
}

function extractDni(text) {
  const labelled = findNearLabels(text, ["dni", "documento", "numero", "número", "number"], /\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b|\b\d{7,8}\b/g);
  if (labelled) return onlyDigits(labelled);

  const compact = String(text || "").replace(/\s+/g, "");
  const mrz = compact.match(/(?:I[DP]ARG|IDARG|ARG)[A-Z<]*?(\d{7,8})(?:<|\d|\b)/i) ||
    compact.match(/(?:ID|I)[A-Z,.]{0,8}(\d{7,8})(?:<|\d|\b)/i);
  if (mrz) return onlyDigits(mrz[1]);

  const candidates = [...text.matchAll(/\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b|\b\d{7,8}\b/g)]
    .map((match) => match[0])
    .map(onlyDigits)
    .filter((digits) => digits.length >= 7 && digits.length <= 8)
    .filter((digits) => !looksLikeDateDigits(digits));

  return candidates[0] || "";
}

function extractCuil(text) {
  const match = text.match(/\b\d{2}[-\s]?\d{7,8}[-\s]?\d\b/);
  return match ? onlyDigits(match[0]) : "";
}

function extractSex(text) {
  const normalized = fold(text).replace(/\s+/g, " ");
  const table = normalized.match(/\bsexo\b.*?\bnacionalidad\b.*?\bejemplar\b\s+([mf])\s+[a-z0-9]{1,3}\s+[a-z0-9]\b/i);
  if (table) return table[1].toUpperCase();
  const tableWithFullNationality = normalized.match(/\b(?:sexo|sex)\b.*?\b(?:nacionalidad|nationality)\b.*?\bejemplar\b\s+([mf])\s+(?:argentina|arg)\s+[a-z0-9]\b/i);
  if (tableWithFullNationality) return tableWithFullNationality[1].toUpperCase();

  const labelled = normalized.match(/\b(?:sexo|sex)\b[^A-ZMF]{0,20}\b([mf])\b/i);
  if (labelled) return labelled[1].toUpperCase();

  const compact = stripAccents(text).replace(/\s+/g, "");
  const mrz = compact.match(/\d{6}\d?([MF])\d{6}/i);
  if (mrz) return mrz[1].toUpperCase();
  const noisyMrz = compact.match(/[A-Z]\d{5}([MF])\d{6}/i);
  if (noisyMrz) return noisyMrz[1].toUpperCase();
  const damagedMrz = compact.match(/[\d:;,]{2,8}([MF])\d{6}/i);
  return damagedMrz ? damagedMrz[1].toUpperCase() : "";
}

function extractNationality(text) {
  const folded = fold(text).replace(/\s+/g, " ");
  const table = folded.match(/\bsexo\b.*?\bnacionalidad\b.*?\bejemplar\b\s+[mf]\s+([a-z0-9]{1,3})\s+[a-z0-9]\b/i);
  const tableNationality = normalizeNationalityCode(table?.[1]);
  if (tableNationality) return tableNationality;

  if (/\b(?:nacionalidad|nationality)\b.{0,60}\b(?:argentina|arg)\b/i.test(folded)) {
    return "Argentina";
  }

  const compact = stripAccents(text).replace(/\s+/g, "");
  if (/\d{6}\d?[MF]<*\d{6}[A-Z0-9]?ARG\b/i.test(compact)) {
    return "Argentina";
  }

  if (/(?:I[DP]ARG|IDARG|[A-Z]{0,3}ARG\d{6,8})/i.test(compact) && !/\b(extranjero|permanente|temporaria|radicaci|disposici|pais de nacimiento)\b/i.test(folded)) {
    return "Argentina";
  }

  return "";
}

function extractBirthDate(text) {
  const datePattern = /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+[A-ZÁÉÍÓÚ]{3,}\.?(?:\s+[A-ZÁÉÍÓÚ]{3,}\.?)?\s+\d{4}\b/gi;
  const labelled = findNearLabels(text, ["fecha de nacimiento", "nacimiento", "birth", "date of birth"], datePattern);
  const direct =
    labelled ||
    text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/)?.[0] ||
    text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ||
    text.match(/\b\d{1,2}\s+[A-ZÁÉÍÓÚ]{3,}\.?(?:\s+[A-ZÁÉÍÓÚ]{3,}\.?)?\s+\d{4}\b/i)?.[0] ||
    parseMrzBirthDate(text) ||
    "";
  return normalizeDateInput(direct);
}

function findNearLabels(text, labels, pattern) {
  const folded = fold(text);
  for (const label of labels.map(fold)) {
    let labelIndex = folded.indexOf(label);
    while (labelIndex !== -1) {
      const windowText = text.slice(labelIndex, labelIndex + 90);
      const match = [...windowText.matchAll(pattern)][0];
      if (match) return match[0];
      labelIndex = folded.indexOf(label, labelIndex + label.length);
    }
  }
  return "";
}

function findLabelValue(lines, labels, excludedLabels = []) {
  const cleanLabels = labels.map(fold);
  const excluded = excludedLabels.map(fold);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const foldedLine = fold(line);
    if (excluded.some((label) => foldedLine.includes(label))) continue;

    const label = cleanLabels.find((item) => includesLabel(foldedLine, item));
    if (!label) continue;

    const inline = valueAfterLabel(line, label);
    if (looksLikePersonName(inline)) return cleanNameCandidate(inline);

    for (const next of lines.slice(index + 1, index + 4)) {
      if (containsKnownLabel(next)) break;
      if (looksLikePersonName(next)) return cleanNameCandidate(next);
    }
  }
  return "";
}

function valueAfterLabel(line, foldedLabel) {
  const foldedLine = fold(line);
  const labelIndex = labelIndexOf(foldedLine, foldedLabel);
  if (labelIndex === -1) return "";

  const after = line.slice(labelIndex + foldedLabel.length);
  return after
    .replace(/^[:;\-_\s/]+/, "")
    .replace(/^(surname|surnam|sumame|surnarne|name|nombre)\b/i, "")
    .replace(/^[:;\-_\s/]+/, "")
    .trim();
}

function includesLabel(foldedLine, label) {
  return labelIndexOf(foldedLine, label) !== -1;
}

function labelIndexOf(foldedLine, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = foldedLine.match(new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`));
  return match ? match.index + match[1].length : -1;
}

function parseMrzName(lines) {
  const mrzLines = lines
    .map((line) => stripAccents(line).toLocaleUpperCase("es-AR").replace(/\s+/g, " "))
    .filter((line) => /<+[A-Z]/.test(line))
    .filter((line) => line.replace(/[^A-Z<]/g, "").length >= 8);

  for (const line of mrzLines) {
    const parsed = parseMrzNameLine(line);
    if (parsed) return parsed;
  }

  return "";
}

function parseMrzNameLine(line) {
  const clean = line
    .replace(/[^A-Z0-9< ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean.includes("<<")) return parseSingleSeparatorMrzName(clean);
  const [rawSurname, ...nameParts] = clean.split("<<");
  const surname = rawSurname
    .split(/<+/)
    .map((part) => part.trim().split(/\s+/).pop() || "")
    .map((part) => (/\d/.test(part) ? "" : part))
    .map((part) => part.replace(/[^A-Z]/g, ""))
    .filter(Boolean)
    .join(" ");
  const nameTokens = nameParts
    .join("<")
    .split(/<+/)
    .map((part) => normalizeMrzNameToken(part.replace(/\s+/g, "")))
    .filter((part) => part && !/^[LSKC]+$/.test(part))
    .filter((part) => part.length > 3 || /[AEIOU]/.test(part))
    .filter((part) => !(surname.includes(part) || part.includes(surname)));
  const names = nameTokens.join(" ");
  if (!surname || !names || surname.replace(/\s+/g, "").length < 3) return parseSingleSeparatorMrzName(clean);
  return normalizeName(`${names} ${surname}`);
}

function normalizeMrzNameToken(token) {
  const corrections = new Map([
    ["IVN", "IVAN"],
    ["PAT", "PABLO"],
  ]);
  const raw = String(token || "");
  if (/\d/.test(raw)) return "";
  let next = raw.replace(/[^A-Z]/g, "");
  if (!next) return "";
  next = next.replace(/^K+(?=[A-Z]{3,})/, "");
  next = next.replace(/[KLC]{2,}.*$/, "");
  if (next.endsWith("K") && next.length > 4) next = next.slice(0, -1);
  return corrections.get(next) || next;
}

function parseSingleSeparatorMrzName(clean) {
  const tokens = clean
    .split(/<+/)
    .map((part) => normalizeMrzNameToken(part.replace(/\s+/g, "")))
    .filter((part) => part && !/^[LK]+$/.test(part))
    .filter((part) => part.length > 3 || /[AEIOU]/.test(part));
  if (tokens.length < 2 || tokens[0].length < 3) return "";
  if (tokens.length === 2 && looksLikeCommonGivenName(tokens[0])) return "";
  const [surname, ...names] = tokens;
  return normalizeName(`${names.join(" ")} ${surname}`);
}

function parseMrzGivenNames(lines) {
  const mrzLines = lines
    .map((line) => stripAccents(line).toLocaleUpperCase("es-AR").replace(/\s+/g, " "))
    .filter((line) => /<+[A-Z]/.test(line))
    .filter((line) => line.replace(/[^A-Z0-9<]/g, "").length >= 8);

  for (const line of mrzLines) {
    const clean = line
      .replace(/[^A-Z0-9< ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const withoutTrailingFill = clean.replace(/<{2,}.*$/, "");
    if (withoutTrailingFill.includes("<<")) continue;
    const tokens = withoutTrailingFill
      .split(/<+/)
      .map((part) => normalizeMrzNameToken(part.replace(/\s+/g, "")))
      .filter((part) => part && !/^[LK]+$/.test(part))
      .filter((part) => part.length > 3 || /[AEIOU]/.test(part));
    if (tokens.length >= 3 && tokens[0].length <= 2 && looksLikeCommonGivenName(tokens[1])) {
      return normalizeName(tokens.slice(1).join(" "));
    }
    if (tokens.length === 2 && looksLikeCommonGivenName(tokens[0])) return normalizeName(tokens.join(" "));
  }

  return "";
}

function looksLikeCommonGivenName(){return false;}

function findUppercaseNameLine(lines) {
  const ignored = /\b(REPUBLICA|ARGENTINA|MERCOSUR|DOCUMENTO|NACIONAL|IDENTIDAD|MINISTERIO|INTERIOR|EJEMPLAR|TRAMITE|FECHA|NACIMIENTO|SEXO|DOMICILIO|NUMERO|APELLIDO|NOMBRES?|HUELLA|DACTILAR|PULGAR)\b/i;
  return lines.find((line) => {
    if (ignored.test(stripAccents(line))) return false;
    if (/\d/.test(line)) return false;
    const clean = line.replace(new RegExp(`[^${SPANISH_UPPERCASE} ]`, "g"), "").trim();
    return clean.length >= 8 && clean.split(/\s+/).length >= 2 && clean === line.trim();
  }) || "";
}

function combineName(names, surname) {
  if (names && surname) return `${names} ${surname}`;
  return names || surname || "";
}

function looksLikePersonName(value) {
  const text = cleanNameCandidate(value);
  if (!text || /\d/.test(text)) return false;
  if (containsKnownLabel(text)) return false;
  if (looksLikeAdministrativeText(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.every((word) => new RegExp(`^[${SPANISH_LETTERS}'-]{2,}$`).test(word));
}

function cleanNameCandidate(value) {
  return stripLeadingOcrNameNoise(repairSplitNameInitials(cleanOcrLine(value)
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()));
}

function repairSplitNameInitials(value) {
  return String(value || "").replace(/\b([A-ZÁÉÍÓÚÜÑ])\s+([A-ZÁÉÍÓÚÜÑ]{3,})\b/g, "$1$2");
}

function stripLeadingOcrNameNoise(value) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const firstUppercaseWord = words.findIndex((word) => word.length >= 2 && word === stripAccents(word).toLocaleUpperCase("es-AR"));
  if (firstUppercaseWord > 0) return words.slice(firstUppercaseWord).join(" ");
  return value;
}

function containsKnownLabel(value) {
  const text = fold(value);
  return [
    "apellido",
    "surname",
    "nombre",
    "name",
    "dni",
    "documento",
    "numero",
    "number",
    "fecha",
    "birth",
    "sexo",
    "sex",
    "domicilio",
    "address",
    "nacionalidad",
    "nationality",
  ].some((label) => text.includes(label));
}

function looksLikeAdministrativeText(value) {
  const text = fold(value);
  return /\b(lugar|nacim|domicilio|huella|dactilar|hijo|firma|registro|republica|argentina|mercosur|ministerio|gabinete|ministro|interior|pulgar|surname|sumame|surnarne)\b/.test(text);
}

function looksLikeDateDigits(digits) {
  if (!/^\d{8}$/.test(digits)) return false;
  const yearFirst = Number(digits.slice(0, 4));
  const monthFirst = Number(digits.slice(4, 6));
  const dayFirst = Number(digits.slice(6, 8));
  return yearFirst >= 1900 && yearFirst <= 2099 && monthFirst >= 1 && monthFirst <= 12 && dayFirst >= 1 && dayFirst <= 31;
}

function normalizeName(value) {
  return repairCommonNameOcr(cleanOcrLine(value))
    .replace(new RegExp(`[^${SPANISH_LETTERS}' -]`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-AR")
    .replace(/(^|\s|-)\S/g, (letter) => letter.toLocaleUpperCase("es-AR"));
}

function repairCommonNameOcr(value){return String(value || "");}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidIsoDate(text) ? text : "";
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return validIsoDateParts(year, month, day) ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : "";
  }

  const monthNameMatch = text.match(/^(\d{1,2})\s+([A-ZÁÉÍÓÚ]{3,})\.?(?:\s+[A-ZÁÉÍÓÚ]{3,}\.?)?\s+(\d{4})$/i);
  if (monthNameMatch) {
    const [, day, monthName, year] = monthNameMatch;
    const month = monthNumber(monthName);
    if (month && validIsoDateParts(year, month, day)) return `${year}-${month}-${day.padStart(2, "0")}`;
  }

  return "";
}

function parseMrzBirthDate(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  const match = compact.match(/\d{7,8}<\d<+(\d{6})\d?[MF<]/i) || compact.match(/(\d{6})\d?[MF<]\d{6}/i);
  if (!match) return "";
  const raw = match[1];
  const yy = Number(raw.slice(0, 2));
  const month = raw.slice(2, 4);
  const day = raw.slice(4, 6);
  const currentTwoDigitYear = Number(new Date().getFullYear().toString().slice(-2));
  const century = yy <= currentTwoDigitYear ? 2000 : 1900;
  if (!validIsoDateParts(String(century + yy), month, day)) return "";
  return `${century + yy}-${month}-${day}`;
}

function extractBirthDateV2(text) {
  const datePattern = /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[,.:]?\s+[A-Za-z0-9]{3,}\.?(?:\s*\/\s*[A-Za-z0-9]{3,}\.?)?\s+\d{4}\b/gi;
  const labelled = findNearLabels(text, ["fecha de nacimiento", "nacimiento", "birth", "date of birth"], datePattern);
  const labelledDate = normalizeDateInputV2(labelled);
  if (labelledDate) return labelledDate;

  const mrzDate = normalizeDateInputV2(parseMrzBirthDate(text));
  if (mrzDate) return mrzDate;

  return earliestPlausibleBirthDate(
    [...text.matchAll(datePattern)]
      .filter((match) => !nearNonBirthDateLabel(text, match.index || 0))
      .map((match) => match[0]),
  );
}

function normalizeDateInputV2(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidIsoDate(text) ? text : "";

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (numeric) {
    const [, day, month, year] = numeric;
    return validIsoDateParts(year, month, day) ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : "";
  }

  const named = text.match(/^(\d{1,2})[,.:]?\s+([A-Za-z0-9]{3,})\.?(?:\s*\/\s*[A-Za-z0-9]{3,}\.?)?\s+(\d{4})$/i);
  if (named) {
    const [, day, monthName, year] = named;
    const month = monthNumber(monthName);
    if (month && validIsoDateParts(year, month, day)) return `${year}-${month}-${day.padStart(2, "0")}`;
  }

  return "";
}

function earliestPlausibleBirthDate(values) {
  const dates = values
    .map((value) => normalizeDateInputV2(value))
    .filter(Boolean)
    .filter(isValidIsoDate)
    .filter((value) => {
      const year = Number(value.slice(0, 4));
      return year >= 1900 && year <= new Date().getFullYear();
    })
    .sort();
  return dates[0] || "";
}

function validIsoDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > new Date().getFullYear()) return false;
  if (m < 1 || m > 12) return false;
  const maxDay = new Date(y, m, 0).getDate();
  return d >= 1 && d <= maxDay;
}

function isValidIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return Boolean(match && validIsoDateParts(match[1], match[2], match[3]));
}

function monthNumber(value) {
  const key = stripAccents(value).slice(0, 3).toLocaleUpperCase("es-AR");
  const months = {
    ENE: "01",
    JAN: "01",
    FEB: "02",
    MAR: "03",
    ABR: "04",
    APR: "04",
    MAY: "05",
    JUN: "06",
    JUL: "07",
    AGO: "08",
    AUG: "08",
    SEP: "09",
    SET: "09",
    OCT: "10",
    NOV: "11",
    N0V: "11",
    NQV: "11",
    DIC: "12",
    DEC: "12",
  };
  return months[key] || "";
}

function normalizeNationalityCode(value) {
  const code = stripAccents(value).replace(/[^A-Za-z0-9]/g, "").toLocaleUpperCase("es-AR");
  if (["ARG", "AR", "AI", "AL", "A1", "ARGENTINA"].includes(code)) return "Argentina";
  return "";
}

function calculateArgentineCuil(dni, sex) {
  const digits = onlyDigits(dni);
  if (!/^\d{7,8}$/.test(digits)) return "";
  const paddedDni = digits.padStart(8, "0");
  const sexCode = String(sex || "").toUpperCase() === "F" ? "27" : String(sex || "").toUpperCase() === "M" ? "20" : "";
  if (!sexCode) return "";
  return calculateCuilWithPrefix(sexCode, paddedDni);
}

function calculateCuilWithPrefix(prefix, paddedDni) {
  const base = `${prefix}${paddedDni}`;
  const checkDigit = calculateCuilCheckDigit(base);
  return checkDigit ? `${base}${checkDigit}` : "";
}

function calculateCuilCheckDigit(base) {
  if (!/^\d{10}$/.test(base)) return "";
  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = base.split("").reduce((total, digit, index) => total + Number(digit) * multipliers[index], 0);
  const remainder = sum % 11;
  const checkDigit = remainder === 0 ? 0 : remainder === 1 ? 9 : 11 - remainder;
  return String(checkDigit);
}

function detectDniDocumentType(text) {
  const folded = fold(text);
  const compact = stripAccents(text).replace(/\s+/g, "");
  if (folded.includes("dni digital") || folded.includes("ultima actualizacion")) return "dni_digital";
  if (/IDARG|<{2,}/i.test(compact)) return "dni_dorso_mrz";
  if (folded.includes("apellido") && folded.includes("nombre") && folded.includes("documento")) return "dni_frente";
  if (/@/.test(text) || /tramite|of ident/i.test(folded)) return "codigo";
  return "desconocido";
}

function confidenceForFields(fields, source, documentType) {
  const barcode = source === "barcode";
  const structured = barcode || documentType === "dni_dorso_mrz";
  return {
    fullName: fields.fullName ? (barcode ? "alta" : "media") : "",
    dni: fields.dni ? (structured ? "alta" : "media") : "",
    cuil: fields.cuil ? (validateArgentineCuil(fields.cuil) ? "alta" : "media") : "",
    birthDate: fields.birthDate ? (structured || documentType === "dni_digital" ? "alta" : "media") : "",
    nationality: fields.nationality ? "media" : "",
  };
}

function parseBarcodeUrlParams(text) {
  const url = String(text || "").match(/https?:\/\/\S+/i)?.[0] || "";
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const surname = firstParam(params, ["apellido", "surname", "ape"]);
    const names = firstParam(params, ["nombre", "nombres", "name", "nom"]);
    const dni = firstParam(params, ["dni", "documento", "numero", "nro", "id"]);
    const cuil = firstParam(params, ["cuil", "cuit"]);
    const birthDate = firstParam(params, ["fechaNacimiento", "fecha_nacimiento", "nacimiento", "birthDate"]);
    const nationality = firstParam(params, ["nacionalidad", "nationality"]);
    return compactFields({
      fullName: normalizeName(combineName(names, surname)),
      dni: onlyDigits(dni),
      cuil: onlyDigits(cuil),
      birthDate: normalizeDateInputV2(birthDate),
      nationality: normalizeNationalityCode(nationality) || (/argentina|arg/i.test(nationality) ? "Argentina" : ""),
      sex: firstParam(params, ["sexo", "sex"]),
    });
  } catch {
    return {};
  }
}

function firstParam(params, names) {
  for (const name of names) {
    const value = params.get(name);
    if (value) return value;
  }
  return "";
}

function parseBarcodeTokens(text) {
  const tokens = String(text || "")
    .split(/[@|\n\r;]+/)
    .map((token) => cleanOcrLine(token))
    .filter(Boolean);
  if (!tokens.length) return {};

  const sexIndex = tokens.findIndex((token) => normalizeBarcodeSex(token));
  const sex = sexIndex !== -1 ? normalizeBarcodeSex(tokens[sexIndex]) : "";
  const cuil = tokens.map(onlyDigits).find((token) => /^\d{11}$/.test(token) && validateArgentineCuil(token)) || "";
  const dni =
    (cuil ? cuil.slice(2, 10) : "") ||
    tokens
      .map(onlyDigits)
      .find((token) => /^\d{7,8}$/.test(token) && !looksLikeDateDigits(token)) ||
    "";
  const dates = tokens
    .map(normalizeDateInputV2)
    .filter(Boolean)
    .filter((value) => Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= new Date().getFullYear())
    .sort();
  const birthDate = dates[0] || "";
  let surname = "";
  let names = "";
  if (sexIndex >= 2 && looksLikePersonName(tokens[sexIndex - 2]) && looksLikePersonName(tokens[sexIndex - 1])) {
    surname = tokens[sexIndex - 2];
    names = tokens[sexIndex - 1];
  } else {
    const nameTokens = tokens.filter((token) => looksLikePersonName(token) && !containsKnownLabel(token));
    surname = nameTokens[0] || "";
    names = nameTokens[1] || "";
  }

  return compactFields({
    fullName: normalizeName(combineName(names, surname)),
    dni,
    cuil,
    birthDate,
    nationality: /ARG|ARGENTINA/i.test(text) ? "Argentina" : "",
    sex,
  });
}

function normalizeBarcodeSex(value) {
  const token = cleanOcrLine(value).toUpperCase();
  if (/^[MF]$/.test(token)) return token;
  if (token === "2") return "F";
  return "";
}

function nearNonBirthDateLabel(text, index) {
  const before = fold(text.slice(Math.max(0, index - 50), index));
  return /emision|emisión|issue|vencimiento|expiry|actualizacion|actualización|updated|tramite|trámite/.test(before);
}

function compactFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function cleanOcrLine(value) {
  return String(value || "")
    .replace(/[|()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fold(value) {
  return stripAccents(value).toLocaleLowerCase("es-AR");
}

function stripAccents(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}
