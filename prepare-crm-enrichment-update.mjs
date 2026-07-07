import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const python = "C:\\Users\\hugoc\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const script = `
import json
from openpyxl import load_workbook

def norm(value):
    import unicodedata, re
    text=unicodedata.normalize('NFD', str(value or '')).encode('ascii','ignore').decode('ascii').lower()
    return re.sub(r'[^a-z0-9]+',' ',text).strip()

cache=json.load(open('capsule-cache.json',encoding='utf-8'))
name_to_org={o['name']: o for o in cache['organisations']}
norm_to_org={norm(o['name']): o for o in cache['organisations']}
wb=load_workbook('outputs/crm-enrichment-full-partners.xlsx', read_only=True, data_only=True)
ws=wb['Parceiros']
headers=[ws.cell(1,c).value for c in range(1, ws.max_column+1)]
idx={h:i for i,h in enumerate(headers)}
rows=[]
missing=[]
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or not r[0]:
        continue
    name=r[idx['Empresa']]
    org=name_to_org.get(name) or norm_to_org.get(norm(name))
    if not org:
        missing.append(name)
        continue
    confidence=(r[idx['Confianca']] or '').strip()
    purpose=(r[idx['Proposito principal']] or '').strip()
    desc=(r[idx['Descricao consolidada']] or '').strip()
    rows.append({
        'id': str(org['id']),
        'name': name,
        'confidence': confidence,
        'purpose': purpose,
        'description': desc,
        'descriptionUpdate': confidence in ('alta','media') and bool(desc),
        'tagUpdate': bool(purpose),
        'source': r[idx['Fonte descricao']],
        'sourceUrl': r[idx['URL fonte']],
        'action': r[idx['Acao sugerida']],
    })

out={
    'sourceXlsx':'outputs/crm-enrichment-full-partners.xlsx',
    'crmSnapshot': cache.get('refreshedAt'),
    'totalRows': len(rows),
    'missing': missing,
    'descriptionUpdates': sum(1 for r in rows if r['descriptionUpdate']),
    'tagUpdates': sum(1 for r in rows if r['tagUpdate']),
    'rows': rows,
}
json.dump(out, open('crm-enrichment-update-plan.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)
print(json.dumps({k: out[k] for k in ('totalRows','descriptionUpdates','tagUpdates','missing')}, ensure_ascii=False))
`;

const child = spawn(python, ["-c", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const code = await new Promise((resolve) => child.on("close", resolve));
if (code !== 0) {
  console.error(stderr);
  process.exit(code);
}
await fs.writeFile("crm-enrichment-update-plan.log", stdout, "utf8");
console.log(stdout.trim());
