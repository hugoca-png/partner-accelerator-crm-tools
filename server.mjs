import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { briefForOrganisation, onePagerFallback, publicBriefCss, renderPublicBrief, renderMicrosoftFit, renderUnregisteredKeyPeople } from "./one-pager-brief.mjs";
import { researchOrganisation } from "./one-pager-research.mjs";
import { researchOrganisationWithOpenAI } from "./one-pager-openai.mjs";
import { renderOnePagerPdf } from "./one-pager-pdf.mjs";
import { existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8788);
const cachePath = join(root, "capsule-cache.json");
const cacheScriptPath = join(root, "capsule-cache.js");
const publicAddressesPath = join(root, "public-addresses.json");
const validationReportPath = join(root, "bouncer-email-validation-last.json");
const logosReportPath = join(root, "prepared-logos", "logos-report.json");
const publicBriefsPath = join(root, "public-briefs.json");
const liveBriefsPath = join(root, "public-briefs-live.json");
const onePagerResearchInFlight = new Map();
let briefWriteQueue = Promise.resolve();
const paLogoDataUri = `data:image/svg+xml;base64,${(await readFile(join(root, "assets", "pa-logo.svg"))).toString("base64")}`;
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
const organisationFieldIds = {
  nif: 957388,
  formalName: 981556,
};
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

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
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
  ["Abilio", "Abílio"], ["Aderito", "Adérito"], ["Americo", "Américo"], ["Andre", "André"], ["Antonio", "António"],
  ["Araujo", "Araújo"],
  ["Bailao", "Bailão"], ["Bras", "Brás"], ["Calo", "Caló"], ["Catia", "Cátia"],
  ["Charreu", "Charréu"], ["Claudia", "Cláudia"], ["Custodio", "Custódio"], ["Cacador", "Caçador"],
  ["Debora", "Débora"],
  ["Estevao", "Estevão"], ["Fatima", "Fátima"], ["Felix", "Félix"],
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

function portugueseStreetLine(value) {
  const line = cleanText(value).replace(/\s+/g, " ");
  if (!line) return "";
  const leadingNumber = line.match(/^(\d+[A-Za-zÀ-ÿ]?(?:\s*[-/]\s*\d+[A-Za-zÀ-ÿ]?)?)\s+(.+)$/u);
  if (!leadingNumber) return line;
  const [, number, street] = leadingNumber;
  if (!street || /\d/.test(street.slice(0, 3))) return line;
  return `${street.replace(/,\s*$/, "")}, ${number.replace(/\s+/g, "")}`;
}

function primaryAddressDetails(party) {
  const address = primaryAddress(party);
  const line1 = portugueseStreetLine(address.street || address.address || address.line1 || address.street1);
  const line2 = cleanText(address.line2 || address.street2);
  const postalCode = cleanText(address.zip || address.postcode || address.postalCode || address.postal_code);
  const city = cleanText(address.city);
  const state = cleanText(address.state || address.region || address.county);
  const country = cleanText(address.country);
  return {
    line1,
    line2,
    postalCode,
    city,
    state,
    country,
    formatted: unique([
      line1,
      line2,
      [postalCode, city].filter(Boolean).join(" "),
      state,
      country,
    ]).join(", "),
  };
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

function customFieldValue(party, definitionId, namePattern) {
  const field = (party.fields || []).find((item) =>
    Number(item.definition?.id) === Number(definitionId) || namePattern.test(item.definition?.name || ""),
  );
  return cleanText(field?.value);
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
    const address = primaryAddressDetails(org);
    return {
      id: String(org.id),
      name: cleanText(org.name) || "(sem nome)",
      formalName: customFieldValue(org, organisationFieldIds.formalName, /^Nome formal$/i),
      nif: customFieldValue(org, organisationFieldIds.nif, /(^|\b)(NIF|NIPC)(\b|$)/i),
      description: cleanText(org.about),
      city: address.city,
      country: address.country,
      address,
      logo: isDefaultOrganisationLogo(org.pictureURL) ? "" : cleanText(org.pictureURL),
      url: websites[0]?.url || "",
      emails,
      genericEmails: genericEmails(emails, domains),
      phones: listPhones(org),
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type,Authorization",
  });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  sendJson(res, 500, { error: error.message || String(error) });
}

function escapeHtml(value) {
  return cleanText(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function initials(value) {
  const parts = cleanText(value).split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : cleanText(value).slice(0, 2)).toUpperCase();
}

function displayUrl(value) {
  return cleanText(value).replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function partnerAcceleratorLogoSvg(className = "pa-logo") {
  return `<img class="${escapeHtml(className)}" src="${paLogoDataUri}" alt="Partner Accelerator" />`;
}

function onePagerContact(contact) {
  const email = contact.selectedEmail || contact.emails?.[0] || "";
  const phones = contact.phones || [];
  const role = (contact.jobTitles || []).filter(Boolean).join(", ");
  const photo = cleanText(contact.photo);
  const tags = [
    ...(contact.tags || []).filter((tag) => !["Email Deliverable", "Email Risky", "Email Catch-All"].includes(tag)).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`),
    ...(contact.dataTags || []).map((tag) => `<span class="pill data">${escapeHtml(tag)}</span>`),
  ].join("");
  return `
    <article class="contact">
      ${photo ? `<img class="avatar" src="${escapeHtml(photo)}" alt="" />` : `<div class="avatar fallback">${escapeHtml(initials(contact.name || "?"))}</div>`}
      <div>
        <h3>${escapeHtml(contact.name || "(sem nome)")}</h3>
        ${role ? `<p class="role">${escapeHtml(role)}</p>` : ""}
        ${tags ? `<div class="tagline compact-tags">${tags}</div>` : ""}
        <div class="contact-lines">
          ${email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : ""}
          ${phones.map((phone) => `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function onePagerAddressLines(address, fallback = {}) {
  return [
    address.line1,
    address.line2,
    [address.postalCode, address.city].filter(Boolean).join(" "),
    address.country || (!address.line1 && !address.line2 ? fallback.country : ""),
  ].map(cleanText).filter(Boolean);
}

function onePagerAddressBlock(org, publicAddress = {}) {
  const fullName = cleanText(org.formalName || publicAddress.formalName || org.name);
  const crmLines = onePagerAddressLines(org.address || {}, org);
  const publicLines = onePagerAddressLines(publicAddress);
  const normalise = (lines) => lines.join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const different = publicLines.length && normalise(publicLines) !== normalise(crmLines);
  const sections = [];
  if (publicLines.length) sections.push({ label: "", lines: publicLines, sourceUrl: publicAddress.sourceUrl });
  if (crmLines.length && (!publicLines.length || different)) sections.push({ label: publicLines.length ? "Outra morada registada" : "", lines: crmLines });
  return `<div class="address-block">
    ${sections.map(({ label, lines, sourceUrl }) => `<div class="address-section">
      ${label ? `<div class="address-label">${escapeHtml(label)}</div>` : ""}
      <div>${escapeHtml(fullName)}</div>
      ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
      ${/^https:\/\//i.test(sourceUrl || "") ? `<a class="address-source" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Fonte da morada</a>` : ""}
    </div>`).join("")}
    ${org.nif ? `<div class="address-nif">NIF: ${escapeHtml(org.nif)}</div>` : ""}
  </div>`;
}

function renderOnePager(org, data, publicAddress, publicBrief = {}, refreshError = "", pdfHref = `/one-pager.pdf?id=${encodeURIComponent(org.id)}`) {
  const fullName = cleanText(org.formalName || publicAddress?.formalName || org.name);
  const address = onePagerAddressBlock(org, publicAddress);
  const orgEmail = org.genericEmails?.[0] || org.emails?.[0] || "";
  const orgPhones = org.phones || [];
  const tags = [
    ...(org.tags || []).filter((tag) => !["Email Deliverable", "Email Risky", "Email Catch-All"].includes(tag)).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`),
    ...(org.dataTags || []).map((tag) => `<span class="pill data">${escapeHtml(tag)}</span>`),
  ].join("");
  const refreshedAt = data.refreshedAt
    ? new Intl.DateTimeFormat("pt-PT", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Lisbon" }).format(new Date(data.refreshedAt))
    : "";
  const companyLogo = org.logo
    ? `<img class="company-logo" src="${escapeHtml(org.logo)}" alt="" />`
    : `<div class="company-logo fallback">${escapeHtml(initials(org.name))}</div>`;
  const contacts = org.contacts?.length
    ? org.contacts.map(onePagerContact).join("")
    : `<p class="empty">Sem contactos registados nesta empresa.</p>`;
  const title = `${fullName} | Partner Accelerator`;
  const pdfFilename = `${org.name.replace(/[^a-z0-9-]+/gi, "-")}-one-pager.pdf`;
  const brief = briefForOrganisation(org, publicBrief);

  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/assets/pa-logo.svg" type="image/svg+xml" />
  <style>
    ${publicBriefCss}
    :root {
      --navy: #1e2761;
      --teal: #009ca6;
      --gold: #f1b434;
      --ink: #17212b;
      --muted: #5d6975;
      --line: #dfe5ee;
      --soft: #f5f8fb;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: #e9eef4;
      color: var(--ink);
      font-family: "Segoe UI", Arial, sans-serif;
      line-height: 1.45;
    }

    .toolbar {
      max-width: 210mm;
      margin: 18px auto 10px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 14px;
    }

    .toolbar a,
    .toolbar button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--navy);
      padding: 8px 11px;
      font: inherit;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }

    .sheet {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto 24px;
      background: #fff;
      box-shadow: 0 18px 50px rgba(23, 33, 43, 0.18);
      padding: 15mm;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .pa-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 4px solid var(--teal);
      padding-bottom: 12px;
    }

    .pa-logo {
      width: 170px;
      height: auto;
      display: block;
    }

    .kicker {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 800;
      text-align: right;
    }

    .hero {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 20px;
      align-items: start;
    }

    .logo-panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .company-logo {
      width: 118px;
      height: 118px;
      object-fit: contain;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fff;
    }

    .fallback {
      display: grid;
      place-items: center;
      background: var(--soft);
      color: var(--navy);
      font-weight: 900;
    }

    h1 {
      margin: 0;
      color: var(--navy);
      font-size: 30px;
      line-height: 1.12;
      letter-spacing: 0;
    }

    .facts {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 12px;
    }

    .fact {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      background: #fff;
    }

    .address-block {
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      line-height: 1.35;
      user-select: text;
      white-space: normal;
    }
    .address-section { margin-top: 8px; }
    .address-label { color: var(--navy); font-size: 11px; text-transform: uppercase; }
    .address-source { display: inline-block; margin-top: 2px; font-size: 10px; font-weight: 500; }
    .address-nif { margin-top: 7px; }
    .commercial-name { margin-top: 3px; color: var(--muted); font-size: 13px; }

    .tagline {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 10px;
    }

    .pill {
      border-radius: 999px;
      background: #e7f6f7;
      color: var(--teal);
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 800;
    }

    .pill.data {
      background: #fff3cf;
      color: #7a5600;
    }

    .logo-panel .tagline {
      justify-content: center;
      margin-top: 0;
      gap: 5px;
    }

    .description {
      border-left: 5px solid var(--gold);
      background: #fff9e8;
      padding: 12px 14px;
      color: #28323b;
      font-size: 14px;
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--navy);
      font-size: 15px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0;
    }

    .section-title::after {
      content: "";
      height: 1px;
      background: var(--line);
      flex: 1;
    }

    .contacts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .contact {
      display: grid;
      grid-template-columns: 46px 1fr;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      break-inside: avoid;
    }

    .avatar {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      object-fit: cover;
      border: 1px solid var(--line);
      font-size: 14px;
    }

    h3 {
      margin: 0;
      color: var(--navy);
      font-size: 14px;
      line-height: 1.2;
    }

    .role {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 11px;
    }

    .compact-tags {
      margin-top: 6px;
      gap: 4px;
    }

    .contact-lines {
      display: flex;
      flex-direction: column;
      gap: 1px;
      margin-top: 5px;
      font-size: 11px;
    }

    a { color: var(--teal); }

    .empty {
      color: var(--muted);
      margin: 0;
    }

    .footer {
      margin-top: auto;
      border-top: 1px solid var(--line);
      padding-top: 8px;
      color: var(--muted);
      font-size: 10px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    @page {
      size: A4;
      margin: 9mm;
    }

    @media print {
      body { background: #fff; }
      .toolbar { display: none; }
      .research-warning { display: none; }
      .sheet {
        display: block;
        width: auto;
        min-height: 0;
        margin: 0;
        box-shadow: none;
        padding: 0;
      }
      .sheet > * + * { margin-top: 6px; }
      .hero { grid-template-columns: 115px 1fr; gap: 14px; }
      .company-logo { width: 96px; height: 96px; }
      .hero, .contact, .section-title, .footer { break-inside: avoid; }
      .section-title { break-after: avoid; }
      .footer { display: none; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <a href="/#org-${escapeHtml(org.id)}">Voltar à lista</a>
    <a href="${escapeHtml(pdfHref)}" download="${escapeHtml(pdfFilename)}">Save as PDF</a>
  </div>
  <main class="sheet">
    <header class="pa-header">
      ${partnerAcceleratorLogoSvg()}
      <div class="kicker">Partner Accelerator<br />one-pager</div>
    </header>
    ${refreshError ? `<section class="description">Atualização pública indisponível: ${escapeHtml(refreshError)}. Abaixo estão os últimos dados guardados.</section>` : ""}
    ${brief.researchWarning ? `<section class="description research-warning">${escapeHtml(brief.researchWarning)}</section>` : ""}

    <section class="hero">
      <div class="logo-panel">
        ${companyLogo}
        ${tags ? `<div class="tagline">${tags}</div>` : ""}
      </div>
      <div>
        <h1>${escapeHtml(fullName)}</h1>
        ${fullName !== org.name ? `<div class="commercial-name">${escapeHtml(org.name)}</div>` : ""}
        ${address}
        <div class="facts">
          ${org.url ? `<a class="fact" href="${escapeHtml(org.url)}">${escapeHtml(displayUrl(org.url))}</a>` : ""}
          ${orgEmail ? `<a class="fact" href="mailto:${escapeHtml(orgEmail)}">${escapeHtml(orgEmail)}</a>` : ""}
          ${orgPhones.map((phone) => `<a class="fact" href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`).join("")}
        </div>
      </div>
    </section>

    ${renderPublicBrief(brief, org.contacts || [])}

    ${renderMicrosoftFit(brief)}

    <section>
      <h2 class="section-title">Contactos registados</h2>
      <div class="contacts">${contacts}</div>
    </section>

    ${renderUnregisteredKeyPeople(brief, org.contacts || [])}

    <footer class="footer">
      <span>Partner Accelerator partners</span>
      ${refreshedAt ? `<span>Dados do CRM atualizados em ${escapeHtml(refreshedAt)}</span>` : ""}
    </footer>
  </main>
</body>
</html>`;
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function deleteOrganisationWithPeople({ id, confirmDelete }) {
  const orgId = cleanText(id);
  if (!orgId) throw new Error("Falta o id da empresa.");

  const cache = await readCache();
  const org = (cache.organisations || []).find((item) => String(item.id) === orgId);
  if (!org) throw new Error(`Empresa ${orgId} não encontrada no cache local.`);
  if (confirmDelete !== true) {
    throw new Error("Confirmação obrigatória em falta.");
  }

  const token = await getToken();
  const personIds = unique((org.contacts || []).flatMap((contact) => contact.ids || []).map(String));
  const deletedPeople = [];
  const errors = [];

  for (const personId of personIds) {
    try {
      await capsuleFetch(`/parties/${personId}`, token, { method: "DELETE" });
      deletedPeople.push(personId);
    } catch (error) {
      errors.push({ type: "person", id: personId, error: error.message || String(error) });
    }
  }

  let deletedOrganisation = false;
  if (!errors.length) {
    try {
      await capsuleFetch(`/parties/${orgId}`, token, { method: "DELETE" });
      deletedOrganisation = true;
    } catch (error) {
      errors.push({ type: "organisation", id: orgId, error: error.message || String(error) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    organisation: { id: org.id, name: org.name },
    requestedPeople: personIds.length,
    deletedPeople,
    deletedOrganisation,
    errors,
  };
  await writeFile(join(root, "review-delete-report.json"), JSON.stringify(report, null, 2), "utf8");

  const data = deletedOrganisation && !errors.length ? await refreshData() : await readCache();
  data.reviewDeletion = {
    ...report,
    outputFile: "review-delete-report.json",
  };
  return data;
}

async function deleteReviewPerson({ ids, id, confirmDelete }) {
  const personIds = unique((Array.isArray(ids) ? ids : [id]).map(cleanText).filter(Boolean));
  if (!personIds.length) throw new Error("Falta o id da pessoa.");
  if (confirmDelete !== true) {
    throw new Error("Confirmação obrigatória em falta.");
  }

  const cache = await readCache();
  let matched = null;
  for (const org of cache.organisations || []) {
    for (const person of org.contacts || []) {
      const contactIds = (person.ids || []).map(String);
      if (personIds.some((personId) => contactIds.includes(String(personId)))) {
        matched = {
          organisation: { id: org.id, name: org.name },
          person: { name: person.name || "", ids: contactIds },
        };
        break;
      }
    }
    if (matched) break;
  }
  if (!matched) throw new Error(`Pessoa ${personIds.join(", ")} não encontrada no cache local.`);

  const token = await getToken();
  const deletedPeople = [];
  const errors = [];
  for (const personId of personIds) {
    try {
      await capsuleFetch(`/parties/${personId}`, token, { method: "DELETE" });
      deletedPeople.push(personId);
    } catch (error) {
      errors.push({ type: "person", id: personId, error: error.message || String(error) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    organisation: matched.organisation,
    person: matched.person,
    requestedPeople: personIds.length,
    deletedPeople,
    errors,
  };
  await writeFile(join(root, "review-delete-person-report.json"), JSON.stringify(report, null, 2), "utf8");

  const data = errors.length ? await readCache() : await refreshData();
  data.reviewPersonDeletion = {
    ...report,
    outputFile: "review-delete-person-report.json",
  };
  return data;
}

async function prepareMissingLogos() {
  const scriptPath = join(root, "prepare-missing-logos.mjs");
  if (!existsSync(scriptPath)) {
    throw new Error("Falta o ficheiro prepare-missing-logos.mjs.");
  }

  // Preserve the previous output when Capsule is unavailable. The child script
  // only clears prepared-logos after this refresh has completed successfully.
  await refreshData();

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
    }, 300000);

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
    const acceptedContentType = /^image\/(gif|jpe?g|png)$/i.test(cleanText(item?.selected?.contentType).split(";")[0]);
    const acceptedExtension = /^https?:\/\/.+\.(gif|jpe?g|png)(\?|$)/i.test(logoUrl);
    if (!acceptedContentType && !acceptedExtension) {
      results.push({ id, name: item.name, status: "skipped", reason: "O logo preparado nao e GIF/JPG/PNG." });
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

function briefDateOrder(item) {
  const value = String(item.date || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const year = value.match(/20\d{2}/)?.[0] || "0000";
  const months = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const month = months.findIndex((name) => value.includes(name));
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

async function readPublicBriefs(path) {
  return existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
}

function pageBrief(live, curated = {}) {
  if (!live?.summary) return curated;
  const preferCurated = live.researchStatus !== "openai-web";
  return {
    ...curated,
    ...live,
    summary: preferCurated && curated.summary ? curated.summary : live.summary,
    capabilities: preferCurated && curated.capabilities?.length ? curated.capabilities : live.capabilities,
    microsoftPathways: live.microsoftPathways?.length ? live.microsoftPathways : curated.microsoftPathways || [],
    microsoftFit: live.microsoftPathways?.length ? live.microsoftFit : curated.microsoftFit || live.microsoftFit || "",
    keyPeople: live.keyPeople?.length ? live.keyPeople : curated.keyPeople || [],
  };
}

async function refreshOnePagerBrief(id) {
  if (onePagerResearchInFlight.has(id)) return onePagerResearchInFlight.get(id);
  const task = (async () => {
    const data = await readCache();
    const org = (data.organisations || []).find((item) => String(item.id) === id);
    if (!org) throw new Error("Empresa não encontrada no cache local.");
    const previous = (await readPublicBriefs(liveBriefsPath))[id];
    const curated = (await readPublicBriefs(publicBriefsPath))[id];
    let official;
    let officialError;
    try { official = await researchOrganisation(org); }
    catch (error) { officialError = error; }
    const apiKey = process.env.OPENAI_API_KEY || await getEnvValue("OPENAI_API_KEY");
    let fresh;
    if (apiKey) {
      try {
        fresh = await researchOrganisationWithOpenAI(org, {
          apiKey, officialBrief: official, model: process.env.OPENAI_MODEL || await getEnvValue("OPENAI_MODEL") || "gpt-5.5",
        });
      } catch (error) {
        fresh = onePagerFallback(org, { previous, curated, official, error });
      }
    } else {
      fresh = onePagerFallback(org, {
        previous, curated, official, error: officialError || new Error("Pesquisa OpenAI não configurada."),
      });
    }
    const brief = curated?.summary ? {
      ...(fresh.researchStatus === "openai-web" ? curated : fresh),
      ...(fresh.researchStatus === "openai-web" ? fresh : curated),
      researchWarning: fresh.researchWarning || "",
      keyPeople: fresh.keyPeople?.length ? fresh.keyPeople : curated.keyPeople || [],
      microsoftPathways: fresh.microsoftPathways?.length ? fresh.microsoftPathways : curated.microsoftPathways || [],
      microsoftFit: fresh.microsoftPathways?.length ? fresh.microsoftFit : curated.microsoftFit || fresh.microsoftFit || "",
      assessment: curated.assessment || fresh.assessment || "",
      unknowns: curated.unknowns || fresh.unknowns || "",
      recent: [...fresh.recent, ...(curated.recent || [])]
        .filter((item, index, all) => all.findIndex((other) => other.sourceUrl === item.sourceUrl) === index)
        .sort((a, b) => briefDateOrder(b).localeCompare(briefDateOrder(a)))
        .slice(0, 5),
      checkedAt: fresh.reviewedAt,
      sources: [...fresh.sources, ...(curated.sources || [])]
        .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index),
    } : { ...fresh, checkedAt: fresh.reviewedAt };
    briefWriteQueue = briefWriteQueue.catch(() => {}).then(async () => {
      const all = await readPublicBriefs(liveBriefsPath);
      all[id] = brief;
      await writeFile(liveBriefsPath, JSON.stringify(all, null, 2), "utf8");
    });
    await briefWriteQueue;
    return brief;
  })().finally(() => onePagerResearchInFlight.delete(id));
  onePagerResearchInFlight.set(id, task);
  return task;
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
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
} else if (process.argv[2] === "--preview-one-pager") {
  const id = cleanText(process.argv[3]);
  const data = await readCache();
  const org = (data.organisations || []).find((item) => String(item.id) === id);
  if (!org) throw new Error(`Empresa ${id} não encontrada no cache local.`);
  const publicAddresses = existsSync(publicAddressesPath) ? JSON.parse(await readFile(publicAddressesPath, "utf8")) : {};
  const publicBriefs = await readPublicBriefs(publicBriefsPath);
  const liveBriefs = await readPublicBriefs(liveBriefsPath);
  const outputDir = join(root, "output", "one-pagers");
  await mkdir(outputDir, { recursive: true });
  const baseName = `${org.name.replace(/[^a-z0-9-]+/gi, "-")}-one-pager`;
  const outputPath = join(outputDir, `${baseName}.html`);
  const pdfPath = join(outputDir, `${baseName}.pdf`);
  const html = renderOnePager(org, data, publicAddresses[id], pageBrief(liveBriefs[id], publicBriefs[id]), "", "__PDF_DATA_URL__");
  const pdf = await renderOnePagerPdf(html);
  await writeFile(pdfPath, pdf);
  await writeFile(outputPath, html.replace("__PDF_DATA_URL__", `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`), "utf8");
  console.log(outputPath);
  console.log(pdfPath);
} else {
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "Content-Type,Authorization",
      });
      res.end();
      return;
    }
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
    if (url.pathname === "/api/review-delete-organisation") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Método não permitido." });
        return;
      }
      sendJson(res, 200, await deleteOrganisationWithPeople(await readRequestJson(req)));
      return;
    }
    if (url.pathname === "/api/review-delete-person") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Método não permitido." });
        return;
      }
      sendJson(res, 200, await deleteReviewPerson(await readRequestJson(req)));
      return;
    }
    if (url.pathname === "/api/one-pager-refresh") {
      const id = cleanText(url.searchParams.get("id"));
      if (!id) {
        sendJson(res, 400, { error: "Falta o ID da empresa." });
        return;
      }
      sendJson(res, 200, { brief: await refreshOnePagerBrief(id) });
      return;
    }
    if (url.pathname === "/one-pager.pdf") {
      const id = cleanText(url.searchParams.get("id"));
      const data = await readCache();
      const org = (data.organisations || []).find((item) => String(item.id) === id);
      if (!org) {
        sendJson(res, 404, { error: "Empresa não encontrada." });
        return;
      }
      const publicAddresses = await readPublicBriefs(publicAddressesPath);
      const publicBriefs = await readPublicBriefs(publicBriefsPath);
      const liveBriefs = await readPublicBriefs(liveBriefsPath);
      const html = renderOnePager(org, data, publicAddresses[id], pageBrief(liveBriefs[id], publicBriefs[id]));
      const pdf = await renderOnePagerPdf(html);
      const filename = `${org.name.replace(/[^a-z0-9-]+/gi, "-")}-one-pager.pdf`;
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": pdf.length,
        "cache-control": "no-store",
      });
      res.end(pdf);
      return;
    }
    if (url.pathname === "/one-pager") {
      const id = cleanText(url.searchParams.get("id"));
      const data = await readCache();
      const org = (data.organisations || []).find((item) => String(item.id) === id);
      if (!org) {
        sendHtml(res, 404, "<!doctype html><meta charset=\"utf-8\"><title>Empresa não encontrada</title><body><h1>Empresa não encontrada</h1><p>Confirma o link ou faz refresh dos dados.</p><p><a href=\"/\">Voltar à lista</a></p></body>");
        return;
      }
      let refreshError = "";
      if (url.searchParams.get("prepared") !== "1") {
        try { await refreshOnePagerBrief(id); }
        catch (error) { refreshError = error.message || "pesquisa pública indisponível"; }
      }
      const publicAddresses = existsSync(publicAddressesPath)
        ? JSON.parse(await readFile(publicAddressesPath, "utf8"))
        : {};
      const publicBriefs = await readPublicBriefs(publicBriefsPath);
      const liveBriefs = await readPublicBriefs(liveBriefsPath);
      sendHtml(res, 200, renderOnePager(org, data, publicAddresses[id], pageBrief(liveBriefs[id], publicBriefs[id]), refreshError));
      return;
    }
    const requested = url.pathname === "/" ? "/index.html" : (url.pathname === "/review" ? "/review.html" : url.pathname);
    const decodedRequested = decodeURIComponent(requested);
    const path = resolve(root, decodedRequested.replace(/^\/+/, ""));
    if (decodedRequested.split(/[\\/]/).some((part) => part.startsWith("."))
      || !path.startsWith(resolve(root) + sep)) {
      sendJson(res, 404, { error: "Não encontrado." });
      return;
    }
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
