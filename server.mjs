import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8787);
const cachePath = join(root, "capsule-cache.json");
const cacheScriptPath = join(root, "capsule-cache.js");
const validationReportPath = join(root, "bouncer-email-validation-last.json");
const logosReportPath = join(root, "prepared-logos", "logos-report.json");
const emailValidationTags = {
  deliverable: "Email Deliverable",
  risky: "Email Risky",
  undeliverable: "Email Undeliverable",
  catchAll: "Email Catch-All",
};
const emailValidationStatusTags = [
  emailValidationTags.deliverable,
  emailValidationTags.risky,
  emailValidationTags.undeliverable,
];
const emailValidationRiskTags = [
  emailValidationTags.risky,
  emailValidationTags.undeliverable,
];
let emailValidationProgress = null;

const freeEmailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.pt",
  "outlook.com",
  "outlook.pt",
  "live.com",
  "live.pt",
  "msn.com",
  "sapo.pt",
  "yahoo.com",
  "yahoo.pt",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
]);

async function getEnvValue(name) {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return "";
  const text = await readFile(envPath, "utf8");
  return text.split(/\r?\n/).find((item) => item.trim().startsWith(`${name}=`))?.slice(name.length + 1).trim() || "";
}

async function getToken() {
  if (!existsSync(join(root, ".env"))) {
    throw new Error("Falta o ficheiro .env com CAPSULE_TOKEN.");
  }
  const token = await getEnvValue("CAPSULE_TOKEN");
  if (!token) throw new Error("CAPSULE_TOKEN vazio no ficheiro .env.");
  return token;
}

async function getBouncerKey() {
  const key = process.env.BOUNCER_API_KEY || await getEnvValue("BOUNCER_API_KEY");
  if (!key) throw new Error("BOUNCER_API_KEY não configurada no ficheiro .env.");
  return key;
}

async function getBouncerCredits() {
  const key = await getBouncerKey();
  const response = await fetch("https://api.usebouncer.com/v1.1/credits", {
    headers: {
      "x-api-key": key,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer ${response.status}: ${text || response.statusText}`);
  const body = JSON.parse(text);
  return {
    credits: Number(body.credits || 0),
    checkedAt: new Date().toISOString(),
  };
}

async function capsuleFetch(path, token, options = {}) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Capsule ${response.status}: ${body || response.statusText}`);
  }

  const data = await response.json();
  return { data, link: response.headers.get("link") || "" };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function partyIdentity(party) {
  return party?.id ? `${party.type || "party"}:${party.id}` : "";
}

function dedupeParties(parties) {
  const seen = new Map();
  const duplicateIds = new Map();
  for (const party of parties) {
    const key = partyIdentity(party);
    if (!key) continue;
    if (seen.has(key)) {
      duplicateIds.set(key, (duplicateIds.get(key) || 1) + 1);
      continue;
    }
    seen.set(key, party);
  }
  return {
    parties: [...seen.values()],
    duplicateIds: [...duplicateIds].map(([id, count]) => ({ id, count })),
  };
}

async function collectPartyPages(token) {
  let url = "/parties?perPage=100&embed=tags,fields,organisation";
  const parties = [];
  const pages = [];
  while (url) {
    const { data, link } = await capsuleFetch(url, token);
    const pageParties = data.parties || [];
    parties.push(...pageParties);
    pages.push({
      count: pageParties.length,
      firstId: pageParties[0]?.id || "",
      lastId: pageParties.at(-1)?.id || "",
      next: Boolean(nextLink(link)),
    });
    url = nextLink(link);
  }
  const deduped = dedupeParties(parties);
  return {
    rawParties: parties,
    parties: deduped.parties,
    diagnostics: {
      rawCount: parties.length,
      uniqueCount: deduped.parties.length,
      duplicateCount: parties.length - deduped.parties.length,
      duplicateIds: deduped.duplicateIds,
      pages,
    },
  };
}

async function fetchAllParties(token) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await collectPartyPages(token);
    attempts.push({ attempt, ...result });
    if (!result.diagnostics.duplicateCount) break;
    await wait(900 * attempt);
  }

  attempts.sort((a, b) => {
    if (a.diagnostics.duplicateCount !== b.diagnostics.duplicateCount) {
      return a.diagnostics.duplicateCount - b.diagnostics.duplicateCount;
    }
    return b.diagnostics.uniqueCount - a.diagnostics.uniqueCount;
  });
  const best = attempts[0];
  Object.defineProperty(best.parties, "fetchDiagnostics", {
    value: {
      ...best.diagnostics,
      attempts: attempts.map((item) => ({
        attempt: item.attempt,
        rawCount: item.diagnostics.rawCount,
        uniqueCount: item.diagnostics.uniqueCount,
        duplicateCount: item.diagnostics.duplicateCount,
      })),
      selectedAttempt: best.attempt,
    },
    enumerable: false,
  });
  return best.parties;
}

function cleanText(value) {
  return String(value || "").trim();
}

function isDefaultOrganisationLogo(value) {
  return /public-assets\/images\/organisation\.svg/i.test(cleanText(value));
}

function lower(value) {
  return cleanText(value).toLocaleLowerCase("pt-PT");
}

function normalizeName(value) {
  return lower(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value) {
  const raw = cleanText(value);
  const plus = raw.startsWith("+") ? "+" : "";
  const digits = raw.replace(/\D/g, "");
  return digits ? `${plus}${digits}` : "";
}

function portuguesePhone(value) {
  const digits = cleanText(value).replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("351")
    ? digits.slice(3)
    : digits.length === 9
      ? digits
      : "";
  if (!/^[29]\d{8}$/.test(national)) return null;
  return {
    key: `351${national}`,
    formatted: `+351 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
  };
}

function phoneQuality(phone) {
  const number = cleanText(phone.number);
  if (/^\+351 \d{3} \d{3} \d{3}$/.test(number)) return 4;
  if (number.startsWith("+351")) return 3;
  if (number.replace(/\D/g, "").startsWith("351")) return 2;
  return 1;
}

function phonePatchForParty(party) {
  const groups = new Map();
  for (const phone of party.phoneNumbers || []) {
    const ptPhone = portuguesePhone(phone.number);
    if (!ptPhone) continue;
    if (!groups.has(ptPhone.key)) groups.set(ptPhone.key, { ptPhone, phones: [] });
    groups.get(ptPhone.key).phones.push(phone);
  }

  const patch = [];
  const formatted = [];
  const removed = [];

  for (const { ptPhone, phones } of groups.values()) {
    const sorted = [...phones].sort((a, b) => phoneQuality(b) - phoneQuality(a));
    const keep = sorted[0];
    if (keep.number !== ptPhone.formatted) {
      patch.push({ id: keep.id, number: ptPhone.formatted });
      formatted.push({ id: keep.id, from: keep.number, to: ptPhone.formatted });
    }
    for (const phone of sorted.slice(1)) {
      patch.push({ id: phone.id, _delete: true });
      removed.push({ id: phone.id, number: phone.number, duplicateOf: ptPhone.formatted });
    }
  }

  return { patch, formatted, removed };
}

async function normalizePhonesInCrm(parties, token) {
  const report = {
    partiesWithChanges: 0,
    numbersFormatted: 0,
    duplicatesRemoved: 0,
    errors: [],
  };

  for (const party of parties) {
    const { patch, formatted, removed } = phonePatchForParty(party);
    if (!patch.length) continue;
    report.partiesWithChanges += 1;
    report.numbersFormatted += formatted.length;
    report.duplicatesRemoved += removed.length;
    try {
      await capsuleFetch(`/parties/${party.id}`, token, {
        method: "PUT",
        body: JSON.stringify({ party: { phoneNumbers: patch } }),
      });
    } catch (error) {
      report.errors.push({
        id: party.id,
        name: party.name || fullName(party),
        error: error.message || String(error),
      });
    }
  }

  return report;
}

const nameAccentReplacements = new Map([
  ["Aragao", "Aragão"], ["Armenio", "Arménio"], ["Vania", "Vânia"],
  ["Aderito", "Adérito"], ["Americo", "Américo"], ["Andre", "André"], ["Antonio", "António"],
  ["Araujo", "Araújo"],
  ["Bailao", "Bailão"], ["Bras", "Brás"], ["Calo", "Caló"], ["Catia", "Cátia"],
  ["Charreu", "Charréu"], ["Claudia", "Cláudia"], ["Custodio", "Custódio"], ["Felix", "Félix"],
  ["Frazao", "Frazão"], ["Gloria", "Glória"], ["Goncalo", "Gonçalo"], ["Goncalves", "Gonçalves"],
  ["Graca", "Graça"], ["Helder", "Hélder"],
  ["Helio", "Hélio"], ["Hilario", "Hilário"], ["Inacio", "Inácio"], ["Ines", "Inês"],
  ["Joao", "João"], ["Jose", "José"], ["Licinio", "Licínio"], ["Lidia", "Lídia"],
  ["Luis", "Luís"], ["Magalhaes", "Magalhães"], ["Mario", "Mário"], ["Mertola", "Mértola"],
  ["Nidia", "Nídia"], ["Osorio", "Osório"], ["Perdigao", "Perdigão"], ["Pincao", "Pinção"],
  ["Quiterio", "Quitério"], ["Ruben", "Rúben"], ["Sergio", "Sérgio"], ["Setubal", "Setúbal"],
  ["Silverio", "Silvério"], ["Simoes", "Simões"], ["Sonia", "Sónia"], ["Tania", "Tânia"],
  ["Tomas", "Tomás"], ["Vitor", "Vítor"],
]);

const nameAccentExclusions = new Set(["nuno braz", "victor marques"]);

function correctNameAccents(value) {
  return cleanText(value)
    .split(/(\s+|-|')/)
    .map((part) => nameAccentReplacements.get(part) || part)
    .join("");
}

async function correctNameAccentsInCrm() {
  const token = await getToken();
  let parties = await fetchAllParties(token);
  const planned = [];

  for (const party of parties) {
    if (party.type !== "person") continue;
    const currentName = normalizeName([party.firstName, party.lastName].map(cleanText).filter(Boolean).join(" "));
    if (nameAccentExclusions.has(currentName)) continue;
    const firstName = correctNameAccents(party.firstName);
    const lastName = correctNameAccents(party.lastName);
    if (firstName === cleanText(party.firstName) && lastName === cleanText(party.lastName)) continue;
    planned.push({
      id: String(party.id),
      before: { firstName: cleanText(party.firstName), lastName: cleanText(party.lastName) },
      after: { firstName, lastName },
      organisation: party.organisation?.name || "",
    });
  }

  const updated = [];
  const errors = [];
  for (const item of planned) {
    try {
      await capsuleFetch(`/parties/${item.id}`, token, {
        method: "PUT",
        body: JSON.stringify({ party: item.after }),
      });
      updated.push(item);
    } catch (error) {
      errors.push({ ...item, error: error.message || String(error) });
    }
  }

  parties = await fetchAllParties(token);
  const data = transform(parties);
  data.nameAccentCorrection = {
    correctedAt: new Date().toISOString(),
    planned: planned.length,
    updated: updated.length,
    errors: errors.length,
    exclusions: ["Nuno Braz", "Victor Marques"],
    outputFile: "name-accent-action-report.json",
  };
  const report = { ...data.nameAccentCorrection, changes: updated, errorDetails: errors };
  await writeFile(join(root, data.nameAccentCorrection.outputFile), JSON.stringify(report, null, 2), "utf8");
  await writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
  await writeFile(cacheScriptPath, `window.CAPSULE_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");
  return data;
}

function normalizeEmail(value) {
  return lower(value);
}

function fullName(person) {
  return [person.title, person.firstName, person.lastName].map(cleanText).filter(Boolean).join(" ");
}

function primaryAddress(party) {
  const addresses = party.addresses || [];
  return addresses.find((address) => cleanText(address.city) || cleanText(address.country)) || {};
}

function primaryCity(party) {
  return cleanText(primaryAddress(party).city);
}

function primaryCountry(party) {
  return cleanText(primaryAddress(party).country);
}

function listEmails(party) {
  return (party.emailAddresses || [])
    .map((entry) => cleanText(entry.address))
    .filter(Boolean);
}

function listPhones(party) {
  return (party.phoneNumbers || [])
    .map((entry) => portuguesePhone(entry.number)?.formatted || cleanText(entry.number))
    .filter(Boolean);
}

function listMobilePhones(party) {
  const mobile = (party.phoneNumbers || [])
    .filter((entry) => /mobile|telem|cell/i.test(`${entry.type || ""} ${entry.label || ""}`))
    .map((entry) => cleanText(entry.number))
    .filter(Boolean);
  return mobile.length ? mobile : listPhones(party);
}

const ignoredDomains = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

function normalizeWebsite(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    return {
      url: url.href,
      domain: url.hostname.replace(/^www\./i, "").toLocaleLowerCase("pt-PT"),
    };
  } catch {
    return null;
  }
}

function listWebsites(party) {
  return (party.websites || [])
    .filter((site) => !site.service || String(site.service).toUpperCase() === "URL")
    .map((site) => cleanText(site.url || site.address))
    .filter(Boolean)
    .map(normalizeWebsite)
    .filter((site) => site && !ignoredDomains.has(site.domain));
}

function listWebDomains(party) {
  return listWebsites(party).map((site) => site.domain);
}

function emailDomain(email) {
  const [, domain = ""] = cleanText(email).split("@");
  return domain.replace(/^www\./i, "").toLocaleLowerCase("pt-PT");
}

function organisationDomainAliases(organisation) {
  const orgName = normalizeName(organisation?.name);
  if (orgName === "tek noticias") return ["sapo.pt"];
  return [];
}

function genericEmails(emails, domains) {
  const genericPrefixes = new Set(["geral", "info", "contacto", "contact", "hello", "admin", "office", "sales"]);
  const matching = emails.filter((email) => domains.includes(emailDomain(email)));
  return matching.filter((email) => genericPrefixes.has(email.split("@")[0].toLocaleLowerCase("pt-PT")));
}

function baseDomain(domain) {
  const parts = cleanText(domain).toLocaleLowerCase("pt-PT").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function compactToken(value) {
  return cleanText(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function currentCompanyEmail(email, organisation) {
  const domain = emailDomain(email);
  if (!domain) return false;
  const domains = unique([...listWebDomains(organisation || {}), ...organisationDomainAliases(organisation)]);
  if (domains.includes(domain)) return true;
  if (domains.some((item) => baseDomain(item) === baseDomain(domain))) return true;
  const emailToken = compactToken(baseDomain(domain).split(".")[0]);
  if (emailToken.length < 4) return false;
  const orgTokens = [organisation?.name, ...domains].map(compactToken).filter(Boolean);
  return orgTokens.some((token) => token.includes(emailToken) || emailToken.includes(token));
}

function oldEmployerEmail(email, organisation) {
  const domain = emailDomain(email);
  if (!domain || freeEmailDomains.has(domain)) return false;
  return !currentCompanyEmail(email, organisation);
}

function chooseContactEmail(contact, organisation) {
  const orgDomains = unique([...(organisation.domains || []), ...organisationDomainAliases(organisation)]);
  const companyEmails = contact.emails.filter((email) => orgDomains.includes(emailDomain(email)));
  if (companyEmails.length) return companyEmails[0];
  if (organisation.genericEmails.length) return organisation.genericEmails[0];
  if (organisation.emails.length) return organisation.emails[0];
  return contact.emails[0] || "";
}

function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function tagInfo(party) {
  const tags = party.tags || [];
  const normalTags = tags.filter((tag) => !tag.dataTag).map((tag) => tag.name).filter(Boolean);
  const dataTags = tags.filter((tag) => tag.dataTag).map((tag) => tag.name).filter(Boolean);
  for (const field of party.fields || []) {
    const tagName = field.definition?.tag?.name || field.tag?.name || "";
    if (tagName) dataTags.push(tagName);
  }
  return {
    tags: unique(normalTags),
    dataTags: unique(dataTags),
  };
}

function partyTagNames(party) {
  return (party.tags || []).map((tag) => tag.name).filter(Boolean);
}

function hasAnyTag(party, names) {
  const current = new Set(partyTagNames(party));
  return names.some((name) => current.has(name));
}

async function fetchPartyTags(token) {
  let url = "/parties/tags?perPage=100";
  const tags = [];
  while (url) {
    const { data, link } = await capsuleFetch(url, token);
    tags.push(...(data.tags || []));
    url = nextLink(link);
  }
  return tags;
}

async function ensureEmailValidationTags(token) {
  const existing = new Map((await fetchPartyTags(token)).map((tag) => [tag.name, tag]));
  const output = {};
  for (const name of Object.values(emailValidationTags)) {
    if (existing.has(name)) {
      output[name] = existing.get(name);
      continue;
    }
    const { data } = await capsuleFetch("/parties/tags", token, {
      method: "POST",
      body: JSON.stringify({ tag: { name, dataTag: false } }),
    });
    output[name] = data.tag;
  }
  return output;
}

function emailRowsForValidation(parties, mode) {
  const organisations = new Map(parties.filter((party) => party.type === "organisation").map((party) => [String(party.id), party]));
  const rows = [];

  for (const person of parties.filter((party) => party.type === "person")) {
    if (mode === "incremental" && hasAnyTag(person, emailValidationStatusTags)) continue;
    if (mode === "risky" && !hasAnyTag(person, emailValidationRiskTags)) continue;

    const organisation = organisations.get(String(person.organisation?.id || ""));
    const domains = listWebDomains(organisation || {});
    for (const email of listEmails(person)) {
      rows.push({
        id: String(person.id),
        name: fullName(person) || person.name || `(sem nome: ${person.id})`,
        organisation: organisation ? organisation.name : "",
        email,
        domainMatch: domains.includes(emailDomain(email)),
        generic: genericEmails([email], domains).includes(email),
      });
    }
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      const key = normalizeEmail(row.email);
      if (!key.includes("@") || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      ...row,
      scorePick: 4 + (row.domainMatch ? 4 : 0) - (row.generic ? 2 : 0),
    }))
    .sort((a, b) =>
      b.scorePick - a.scorePick ||
      a.organisation.localeCompare(b.organisation, "pt-PT") ||
      a.email.localeCompare(b.email, "pt-PT"),
    );
}

async function verifyEmailsWithBouncer(emails) {
  if (!emails.length) return [];
  const key = await getBouncerKey();
  const results = [];
  for (let index = 0; index < emails.length; index += 100) {
    const chunk = emails.slice(index, index + 100);
    if (emailValidationProgress) {
      emailValidationProgress.phase = "Bouncer";
      emailValidationProgress.processed = index;
      emailValidationProgress.total = emails.length;
      emailValidationProgress.message = `A validar emails no Bouncer (${index}/${emails.length})`;
    }
    const response = await fetch("https://api.usebouncer.com/v1.1/email/verify/batch/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify(chunk),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Bouncer ${response.status}: ${text || response.statusText}`);
    results.push(...JSON.parse(text));
    if (emailValidationProgress) {
      emailValidationProgress.processed = Math.min(index + chunk.length, emails.length);
      emailValidationProgress.message = `A validar emails no Bouncer (${emailValidationProgress.processed}/${emails.length})`;
    }
  }
  return results;
}

function validationTagNamesForResult(result) {
  const tags = [];
  if (result.status === "deliverable") tags.push(emailValidationTags.deliverable);
  if (result.status === "risky") tags.push(emailValidationTags.risky);
  if (result.status === "undeliverable") tags.push(emailValidationTags.undeliverable);
  if (result.domain?.acceptAll === "yes") tags.push(emailValidationTags.catchAll);
  return tags;
}

async function applyEmailValidationTags(personId, result, token, tagDefinitions) {
  const current = (await capsuleFetch(`/parties/${personId}?embed=tags`, token)).data.party;
  const currentTagIds = new Set((current.tags || []).map((tag) => String(tag.id)));
  const desiredTagIds = new Set(validationTagNamesForResult(result)
    .map((name) => tagDefinitions[name])
    .filter((tag) => tag?.id)
    .map((tag) => String(tag.id)));
  const nextTags = validationTagNamesForResult(result)
    .map((name) => tagDefinitions[name])
    .filter((tag) => tag?.id)
    .filter((tag) => !currentTagIds.has(String(tag.id)))
    .map((tag) => ({ id: tag.id }));
  const removeTags = Object.values(tagDefinitions)
    .filter((tag) => tag?.id && currentTagIds.has(String(tag.id)) && !desiredTagIds.has(String(tag.id)))
    .map((tag) => ({ id: tag.id, _delete: true }));

  if (!nextTags.length && !removeTags.length) return current;

  const { data } = await capsuleFetch(`/parties/${personId}?embed=tags`, token, {
    method: "PUT",
    body: JSON.stringify({ party: { tags: [...removeTags, ...nextTags] } }),
  });
  return data.party;
}

function validationCriteria(mode) {
  if (mode === "incremental") {
    return "Incremental: só contactos sem Email Deliverable, Email Risky ou Email Undeliverable; emails duplicados são validados uma só vez.";
  }
  if (mode === "risky") {
    return "Risco: só contactos com Email Risky ou Email Undeliverable; se forem apagados/corrigidos no CRM saem desta fila.";
  }
  return "Completa: todos os emails de pessoas no CRM, com deduplicação por endereço; usar só em último caso por consumir créditos.";
}

async function validateEmails(mode = "incremental", options = {}) {
  if (!["incremental", "risky", "full"].includes(mode)) throw new Error("Modo de validação inválido.");
  emailValidationProgress = {
    active: true,
    mode,
    phase: "Preparação",
    processed: 0,
    total: 0,
    message: "A preparar validação de emails",
    startedAt: new Date().toISOString(),
  };
  try {
  const token = await getToken();
  let parties = await fetchAllParties(token);
  const rows = emailRowsForValidation(parties, mode);
  emailValidationProgress.total = rows.length;
  emailValidationProgress.message = `Preparados ${rows.length} emails para validação`;
  if (options.dryRun) {
    const data = transform(parties);
    data.emailValidation = {
      mode,
      criteria: validationCriteria(mode),
      checked: rows.length,
      counts: { planned: rows.length },
      riskCount: 0,
      catchAllCount: 0,
      outputFile: "",
      validatedAt: new Date().toISOString(),
      dryRun: true,
    };
    return data;
  }
  emailValidationProgress.phase = "Tags";
  emailValidationProgress.processed = 0;
  emailValidationProgress.message = "A preparar tags no Capsule";
  const tagDefinitions = await ensureEmailValidationTags(token);
  const results = await verifyEmailsWithBouncer(rows.map((row) => row.email));
  const byEmail = new Map(results.map((result) => [normalizeEmail(result.email), result]));
  const outputRows = rows.map((row) => {
    const result = byEmail.get(normalizeEmail(row.email)) || {};
    return {
      ...row,
      bouncer: {
        status: result.status || "",
        reason: result.reason || "",
        score: result.score ?? null,
        acceptAll: result.domain?.acceptAll || "",
        role: result.account?.role || "",
        disposable: result.domain?.disposable || "",
        free: result.domain?.free || "",
        provider: result.provider || "",
      },
      appliedTags: validationTagNamesForResult(result),
      updatedTags: [],
      sendRisk: result.status === "undeliverable",
    };
  });

  const severity = { undeliverable: 3, risky: 2, deliverable: 1 };
  const aggregateByPerson = new Map();
  for (const row of outputRows.filter((item) => item.bouncer.status)) {
    const current = aggregateByPerson.get(row.id);
    const aggregate = {
      status: row.bouncer.status,
      domain: { acceptAll: row.bouncer.acceptAll },
    };
    if (!current || (severity[row.bouncer.status] || 0) > (severity[current.status] || 0)) {
      aggregateByPerson.set(row.id, aggregate);
    } else if (row.bouncer.acceptAll === "yes") {
      current.domain.acceptAll = "yes";
    }
  }

  const updates = [...aggregateByPerson.entries()];
  emailValidationProgress.phase = "Capsule";
  emailValidationProgress.processed = 0;
  emailValidationProgress.total = updates.length;
  emailValidationProgress.message = `A atualizar contactos no Capsule (0/${updates.length})`;
  let updateIndex = 0;
  for (const [personId, result] of updates) {
    const updated = await applyEmailValidationTags(personId, result, token, tagDefinitions);
    const updatedTags = partyTagNames(updated);
    outputRows
      .filter((row) => row.id === personId)
      .forEach((row) => {
        row.updatedTags = updatedTags;
      });
    updateIndex += 1;
    emailValidationProgress.processed = updateIndex;
    emailValidationProgress.message = `A atualizar contactos no Capsule (${updateIndex}/${updates.length})`;
  }

  emailValidationProgress.phase = "Refresh";
  emailValidationProgress.processed = 0;
  emailValidationProgress.total = 1;
  emailValidationProgress.message = "A refrescar snapshot local";
  parties = await fetchAllParties(token);
  const data = transform(parties);
  data.emailValidation = {
    mode,
    criteria: validationCriteria(mode),
    checked: outputRows.length,
    counts: outputRows.reduce((acc, row) => {
      const key = row.bouncer.status || "missing";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    riskCount: outputRows.filter((row) => row.sendRisk).length,
    catchAllCount: outputRows.filter((row) => row.bouncer.acceptAll === "yes").length,
    outputFile: "bouncer-email-validation-last.json",
    validatedAt: new Date().toISOString(),
  };
  await writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
  await writeFile(cacheScriptPath, `window.CAPSULE_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");

  const report = {
    ...data.emailValidation,
    rows: outputRows.filter((row) => row.sendRisk),
  };
  await writeFile(validationReportPath, JSON.stringify(report, null, 2), "utf8");
  emailValidationProgress = {
    active: false,
    mode,
    phase: "Concluído",
    processed: outputRows.length,
    total: outputRows.length,
    message: `Validação concluída: ${outputRows.length} emails`,
    finishedAt: new Date().toISOString(),
  };
  return data;
  } catch (error) {
    emailValidationProgress = {
      ...(emailValidationProgress || {}),
      active: false,
      phase: "Erro",
      message: error.message || String(error),
      error: error.message || String(error),
      finishedAt: new Date().toISOString(),
    };
    throw error;
  }
}

async function cleanupLowQualityEmails() {
  const token = await getToken();
  let parties = await fetchAllParties(token);
  const organisations = new Map(parties.filter((party) => party.type === "organisation").map((party) => [String(party.id), party]));
  const planned = [];

  for (const person of parties.filter((party) => party.type === "person")) {
    const organisation = organisations.get(String(person.organisation?.id || ""));
    const isBouncerLowQuality = hasAnyTag(person, [emailValidationTags.risky]);
    const remove = [];

    for (const emailEntry of person.emailAddresses || []) {
      const email = cleanText(emailEntry.address);
      const domain = emailDomain(email);
      const reasons = [];
      if (organisation && oldEmployerEmail(email, organisation)) reasons.push("entidade empregadora antiga");
      if (isBouncerLowQuality && freeEmailDomains.has(domain)) reasons.push("baixa qualidade Bouncer");
      if (!reasons.length) continue;
      remove.push({
        id: emailEntry.id,
        address: email,
        type: emailEntry.type || "",
        reasons,
      });
    }

    if (remove.length) {
      planned.push({
        partyId: String(person.id),
        party: fullName(person) || person.name || `(sem nome: ${person.id})`,
        organisation: organisation?.name || "",
        remove,
        remainingEmails: (person.emailAddresses || [])
          .filter((entry) => !remove.some((item) => String(item.id) === String(entry.id)))
          .map((entry) => entry.address)
          .filter(Boolean),
      });
    }
  }

  const updated = [];
  const errors = [];
  for (const item of planned) {
    try {
      await capsuleFetch(`/parties/${item.partyId}`, token, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            emailAddresses: item.remove.map((entry) => ({ id: entry.id, _delete: true })),
          },
        }),
      });
      updated.push({ ...item, status: "updated" });
    } catch (error) {
      errors.push({ ...item, status: "error", error: error.message || String(error) });
    }
  }

  parties = await fetchAllParties(token);
  const data = transform(parties);
  data.emailCleanup = {
    cleanedAt: new Date().toISOString(),
    criteria: [
      "Emails corporativos cujo domínio não coincide com a organização atual.",
      "Emails pessoais/free-mail em contactos marcados com Email Risky pelo Bouncer.",
      "Email Risky e Email Catch-All continuam considerados OK na listagem, exceto quando o endereço é free-mail de baixa qualidade.",
    ],
    plannedEmails: planned.reduce((sum, item) => sum + item.remove.length, 0),
    updatedProfiles: updated.length,
    errors: errors.length,
    outputFile: "email-cleanup-report.json",
  };

  const report = {
    ...data.emailCleanup,
    planned,
    updated,
    errors,
  };
  await writeFile(join(root, "email-cleanup-report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
  await writeFile(cacheScriptPath, `window.CAPSULE_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");
  return data;
}

function mergeContact(existing, person, organisation) {
  const emails = unique([...existing.emails, ...listEmails(person)]);
  const phones = unique([...existing.phones, ...listMobilePhones(person)]);
  const orgRefs = unique([...existing.orgRefs, organisation ? organisation.name : ""]);
  const tags = unique([...existing.tags, ...tagInfo(person).tags]);
  const dataTags = unique([...existing.dataTags, ...tagInfo(person).dataTags]);
  const photos = unique([...existing.photos, cleanText(person.pictureURL)]);
  existing.ids = unique([...existing.ids, String(person.id)]);
  existing.name = existing.name || fullName(person);
  existing.emails = emails;
  existing.phones = phones;
  existing.photos = photos;
  existing.photo = existing.photo || photos[0] || "";
  existing.orgRefs = orgRefs;
  existing.tags = tags;
  existing.dataTags = dataTags;
  existing.jobTitles = unique([...existing.jobTitles, cleanText(person.jobTitle)]);
  existing.duplicate = existing.ids.length > 1;
  return existing;
}

function contactKey(person) {
  const emails = listEmails(person).map(normalizeEmail).filter(Boolean).sort();
  if (emails.length) return `email:${emails[0]}`;
  const name = normalizeName(fullName(person));
  const phones = listPhones(person).map(normalizePhone).filter(Boolean).sort();
  if (name && phones.length) return `name-phone:${name}:${phones[0]}`;
  return `id:${person.id}`;
}

function possibleOrgDuplicates(organisations) {
  const groups = new Map();
  for (const org of organisations) {
    const names = [normalizeName(org.name)];
    const city = normalizeName(org.city);
    const domains = org.domains || [];
    const keys = [
      city && names[0] ? `name-city:${names[0]}:${city}` : "",
      ...domains.map((domain) => `domain:${domain}`),
    ].filter(Boolean);
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(org.id);
    }
  }
  const byOrg = new Map();
  for (const ids of groups.values()) {
    const uniqueIds = unique(ids.map(String));
    if (uniqueIds.length < 2) continue;
    for (const id of uniqueIds) {
      const others = uniqueIds.filter((other) => other !== id);
      byOrg.set(id, unique([...(byOrg.get(id) || []), ...others]));
    }
  }
  return byOrg;
}

function possibleContactDuplicateGroups(people) {
  const groups = new Map();
  for (const person of people) {
    const name = normalizeName(fullName(person));
    const emails = listEmails(person).map(normalizeEmail).filter(Boolean);
    const phones = listPhones(person).map(normalizePhone).filter(Boolean);
    const keys = [
      ...emails.map((email) => `email:${email}`),
      ...(name ? phones.map((phone) => `name-phone:${name}:${phone}`) : []),
    ];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(String(person.id));
    }
  }

  const byPerson = new Map();
  for (const ids of groups.values()) {
    const uniqueIds = unique(ids);
    if (uniqueIds.length < 2) continue;
    for (const id of uniqueIds) {
      byPerson.set(id, unique([...(byPerson.get(id) || []), ...uniqueIds.filter((other) => other !== id)]));
    }
  }
  return byPerson;
}

function transform(parties) {
  const inputDiagnostics = parties.fetchDiagnostics || {};
  const dedupedInput = dedupeParties(parties);
  const uniqueParties = dedupedInput.parties;
  const orgParties = uniqueParties.filter((party) => party.type === "organisation");
  const people = uniqueParties.filter((party) => party.type === "person");
  const emailAddressCounts = uniqueParties.reduce(
    (counts, party) => {
      for (const entry of party.emailAddresses || []) {
        const type = cleanText(entry.type).toLocaleLowerCase("en-US");
        if (type === "work") counts.work += 1;
        if (type === "home") counts.home += 1;
      }
      return counts;
    },
    { work: 0, home: 0 },
  );
  const orgMap = new Map(orgParties.map((org) => [String(org.id), org]));
  const unlinkedPeople = people.filter((person) => !person.organisation?.id);
  const contactDuplicateMap = possibleContactDuplicateGroups(people);

  const organisations = orgParties.map((org) => {
    const { tags, dataTags } = tagInfo(org);
    const websites = listWebsites(org);
    const emails = unique(listEmails(org));
    const domains = unique([...websites.map((site) => site.domain), ...organisationDomainAliases(org)]);
    return {
      id: String(org.id),
      name: cleanText(org.name) || "(sem nome)",
      city: primaryCity(org),
      country: primaryCountry(org),
      logo: isDefaultOrganisationLogo(org.pictureURL) ? "" : cleanText(org.pictureURL),
      url: websites[0]?.url || "",
      emails,
      genericEmails: genericEmails(emails, domains),
      tags,
      dataTags,
      domains,
      contacts: [],
    };
  });
  const outputOrgMap = new Map(organisations.map((org) => [org.id, org]));

  const globalContacts = new Map();
  let duplicateContactsMerged = 0;

  for (const person of people) {
    const orgId = person.organisation?.id ? String(person.organisation.id) : "";
    const outputOrg = orgId ? outputOrgMap.get(orgId) : null;
    if (!outputOrg) continue;

    const key = contactKey(person);
    const existing = globalContacts.get(key);
    if (existing) {
      duplicateContactsMerged += 1;
      mergeContact(existing, person, outputOrg);
    } else {
      const { tags, dataTags } = tagInfo(person);
      globalContacts.set(key, {
        ids: [String(person.id)],
        key,
        name: fullName(person) || "(sem nome)",
        emails: unique(listEmails(person)),
        phones: unique(listMobilePhones(person)),
        photo: cleanText(person.pictureURL),
        photos: unique([cleanText(person.pictureURL)]),
        jobTitles: unique([cleanText(person.jobTitle)]),
        orgRefs: [outputOrg.name],
        duplicate: Boolean(contactDuplicateMap.get(String(person.id))?.length),
        duplicateIds: contactDuplicateMap.get(String(person.id)) || [],
        tags,
        dataTags,
      });
    }
  }

  const contacts = [...globalContacts.values()];
  const contactById = new Map();
  for (const contact of contacts) {
    for (const id of contact.ids) contactById.set(id, contact);
  }

  for (const person of people) {
    const orgId = person.organisation?.id ? String(person.organisation.id) : "";
    const outputOrg = orgId ? outputOrgMap.get(orgId) : null;
    if (!outputOrg) continue;
    const contact = contactById.get(String(person.id));
    if (contact && !outputOrg.contacts.some((item) => item.key === contact.key)) {
      outputOrg.contacts.push({
        ...contact,
        duplicate: contact.duplicate || Boolean(contactDuplicateMap.get(String(person.id))?.length),
        duplicateIds: unique([...(contact.duplicateIds || []), ...(contactDuplicateMap.get(String(person.id)) || [])]),
        selectedEmail: chooseContactEmail(contact, outputOrg),
      });
    }
  }

  for (const org of organisations) {
    org.filterTags = unique([...org.tags, ...org.contacts.flatMap((contact) => contact.tags || [])]);
    org.filterDataTags = unique([...org.dataTags, ...org.contacts.flatMap((contact) => contact.dataTags || [])]);
  }

  const duplicateMap = possibleOrgDuplicates(organisations);
  for (const org of organisations) {
    org.possibleDuplicateIds = duplicateMap.get(org.id) || [];
    org.possibleDuplicateNames = org.possibleDuplicateIds
      .map((id) => outputOrgMap.get(String(id))?.name)
      .filter(Boolean);
    org.qualityFlags = [
      ...(org.contacts.length ? [] : ["sem contactos"]),
      ...(org.possibleDuplicateIds.length ? ["duplicado"] : []),
      ...(org.logo ? [] : ["sem logotipo"]),
    ];
  }

  organisations.sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));
  for (const org of organisations) {
    org.contacts.sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));
  }

  const allTags = unique(organisations.flatMap((org) => org.filterTags)).sort((a, b) => a.localeCompare(b, "pt-PT"));
  const allDataTags = unique(organisations.flatMap((org) => org.filterDataTags)).sort((a, b) => a.localeCompare(b, "pt-PT"));

  return {
    refreshedAt: new Date().toISOString(),
    sourcePartyCount: uniqueParties.length,
    refreshDiagnostics: {
      rawPartyCount: inputDiagnostics.rawCount || parties.length,
      uniquePartyCount: uniqueParties.length,
      duplicatePartyCount: Math.max(inputDiagnostics.duplicateCount || 0, parties.length - uniqueParties.length),
      duplicatePartyIds: inputDiagnostics.duplicateIds || dedupedInput.duplicateIds,
      selectedAttempt: inputDiagnostics.selectedAttempt || 1,
      attempts: inputDiagnostics.attempts || [],
    },
    organisationCount: organisations.length,
    personCount: contacts.length,
    emailAddressCounts,
    duplicateContactsMerged,
    possibleDuplicateOrganisationCount: organisations.filter((org) => org.possibleDuplicateIds.length).length,
    dataQuality: {
      organisationsWithoutContacts: organisations
        .filter((org) => !org.contacts.length)
        .map((org) => ({ id: org.id, name: org.name })),
      unlinkedPeople: unlinkedPeople.map((person) => ({
        id: String(person.id),
        name: fullName(person) || "(sem nome)",
        emails: listEmails(person),
        phones: listPhones(person),
      })),
      possibleDuplicateOrganisations: organisations
        .filter((org) => org.possibleDuplicateIds.length)
        .map((org) => ({ id: org.id, name: org.name, duplicates: org.possibleDuplicateNames })),
      possibleDuplicateContacts: contacts
        .filter((contact) => contact.duplicate || contact.duplicateIds?.length)
        .map((contact) => ({ ids: contact.ids, name: contact.name, duplicateIds: contact.duplicateIds || [] })),
      organisationsWithoutLogo: organisations
        .filter((org) => !org.logo)
        .map((org) => ({ id: org.id, name: org.name, url: org.url })),
      contactsWithoutPhoto: contacts
        .filter((contact) => !contact.photo)
        .map((contact) => ({ ids: contact.ids, name: contact.name, orgRefs: contact.orgRefs })),
    },
    allTags,
    allDataTags,
    organisations,
  };
}

async function refreshData() {
  const token = await getToken();
  let parties = await fetchAllParties(token);
  const phoneNormalization = await normalizePhonesInCrm(parties, token);
  if (phoneNormalization.partiesWithChanges && !phoneNormalization.errors.length) {
    parties = await fetchAllParties(token);
  }
  const data = transform(parties);
  data.phoneNormalization = phoneNormalization;
  await writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
  await writeFile(cacheScriptPath, `window.CAPSULE_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");
  return data;
}

async function normalizePhonesAndRefresh() {
  const data = await refreshData();
  data.phoneNormalization.outputFile = "mobile-phone-normalize-dedupe-report.json";
  await writeFile(join(root, data.phoneNormalization.outputFile), JSON.stringify({
    generatedAt: new Date().toISOString(),
    criteria: "Telefones portugueses começados por 2 ou 9, com ou sem prefixo 351, são formatados como +351 XXX XXX XXX; duplicados inequívocos do mesmo número são removidos.",
    ...data.phoneNormalization,
  }, null, 2), "utf8");
  return data;
}

async function readCache() {
  if (!existsSync(cachePath)) return refreshData();
  return JSON.parse(await readFile(cachePath, "utf8"));
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  sendJson(res, 500, { error: error.message || String(error) });
}

function prepareMissingLogos() {
  const scriptPath = join(root, "prepare-missing-logos.mjs");
  if (!existsSync(scriptPath)) {
    throw new Error("Falta o ficheiro prepare-missing-logos.mjs.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("A preparação dos logos demorou demasiado."));
    }, 120000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `prepare-missing-logos terminou com código ${code}.`));
        return;
      }
      let summary = {};
      try {
        summary = JSON.parse(stdout.trim());
      } catch {
        summary = { stdout: stdout.trim() };
      }
      resolve({
        missingLogos: {
          ...summary,
          reportUrl: "/prepared-logos/index.html",
          generatedAt: new Date().toISOString(),
        },
      });
    });
  });
}

function publicLogoUrl(item) {
  const url = cleanText(item?.selected?.finalUrl || item?.selected?.url);
  return url.replaceAll("&amp;", "&");
}

async function uploadPreparedLogosToCrm({ dryRun = false } = {}) {
  if (!existsSync(logosReportPath)) {
    throw new Error("Ainda nao existe relatorio de logos preparados. Corre primeiro 'Preparar logos em falta'.");
  }

  const report = JSON.parse(await readFile(logosReportPath, "utf8"));
  const cache = await readCache();
  const organisations = new Map((cache.organisations || []).map((org) => [String(org.id), org]));
  const token = await getToken();
  const results = [];

  for (const item of report.results || []) {
    const id = String(item.id || "");
    const org = organisations.get(id);
    const logoUrl = publicLogoUrl(item);

    if (!item.selected || !logoUrl) {
      results.push({ id, name: item.name, status: "skipped", reason: "Sem logo preparado." });
      continue;
    }
    if (org?.logo && !isDefaultOrganisationLogo(org.logo)) {
      results.push({ id, name: item.name, status: "skipped", reason: "A empresa ja tem logo no CRM/cache." });
      continue;
    }
    if (!/^https?:\/\/.+\.(gif|jpe?g|png)(\?|$)/i.test(logoUrl)) {
      results.push({ id, name: item.name, status: "skipped", reason: "URL do logo nao parece ser GIF/JPG/PNG publico." });
      continue;
    }

    try {
      if (dryRun) {
        results.push({ id, name: item.name, status: "wouldUpdate", logoUrl });
      } else {
        await capsuleFetch(`/parties/${id}`, token, {
          method: "PUT",
          body: JSON.stringify({ party: { pictureURL: logoUrl } }),
        });
        results.push({ id, name: item.name, status: "updated", logoUrl });
      }
    } catch (error) {
      results.push({ id, name: item.name, status: "error", reason: error.message || String(error), logoUrl });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    dryRun,
    sourceReportGeneratedAt: report.generatedAt || "",
    totalPrepared: (report.results || []).filter((item) => item.selected).length,
    wouldUpdate: results.filter((item) => item.status === "wouldUpdate").length,
    updated: results.filter((item) => item.status === "updated").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    errors: results.filter((item) => item.status === "error").length,
    results,
  };
  await writeFile(join(root, "prepared-logos", "crm-upload-report.json"), JSON.stringify(summary, null, 2), "utf8");

  const data = summary.updated ? await refreshData() : await readCache();
  data.logoUpload = {
    ...summary,
    outputFile: "prepared-logos/crm-upload-report.json",
  };
  return data;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

if (process.argv.includes("--refresh-once")) {
  refreshData()
    .then((data) => {
      console.log(
        JSON.stringify(
          {
            refreshedAt: data.refreshedAt,
            organisations: data.organisationCount,
            people: data.personCount,
            duplicateContactsMerged: data.duplicateContactsMerged,
            possibleDuplicateOrganisations: data.possibleDuplicateOrganisationCount,
          },
          null,
          2,
        ),
      );
    })
    .catch((error) => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
} else {
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        port,
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    if (url.pathname === "/api/data") {
      sendJson(res, 200, await readCache());
      return;
    }
    if (url.pathname === "/api/refresh") {
      sendJson(res, 200, await refreshData());
      return;
    }
    if (url.pathname === "/api/email-validation") {
      sendJson(res, 200, await validateEmails(url.searchParams.get("mode") || "incremental", {
        dryRun: url.searchParams.get("dryRun") === "1",
      }));
      return;
    }
    if (url.pathname === "/api/email-validation-progress") {
      sendJson(res, 200, emailValidationProgress || {
        active: false,
        phase: "Inativo",
        processed: 0,
        total: 0,
        message: "Sem validação em curso",
      });
      return;
    }
    if (url.pathname === "/api/bouncer-credits") {
      sendJson(res, 200, await getBouncerCredits());
      return;
    }
    if (url.pathname === "/api/email-cleanup") {
      sendJson(res, 200, await cleanupLowQualityEmails());
      return;
    }
    if (url.pathname === "/api/phone-normalization") {
      sendJson(res, 200, await normalizePhonesAndRefresh());
      return;
    }
    if (url.pathname === "/api/name-accents") {
      sendJson(res, 200, await correctNameAccentsInCrm());
      return;
    }
    if (url.pathname === "/api/missing-logos") {
      sendJson(res, 200, await prepareMissingLogos());
      return;
    }
    if (url.pathname === "/api/upload-missing-logos") {
      sendJson(res, 200, await uploadPreparedLogosToCrm({
        dryRun: url.searchParams.get("dryRun") === "1",
      }));
      return;
    }
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = join(root, requested.replace(/^\/+/, ""));
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": mime[extname(path)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "Não encontrado." });
    } else {
      sendError(res, error);
    }
  }
});

server.listen(port, () => {
  console.log(`Capsule export available at http://localhost:${port}`);
});
}
