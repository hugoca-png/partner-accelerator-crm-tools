import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const path = "outputs/crm-business-segmentation.xlsx";
const input = await FileBlob.load(path);
const workbook = await SpreadsheetFile.importXlsx(input);

const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 2000 });
const summary = await workbook.inspect({
  kind: "table",
  range: "Resumo!A1:H20",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 8,
  maxChars: 4000,
});
const detail = await workbook.inspect({
  kind: "table",
  range: "Segmentacao!A1:W8",
  include: "values,formulas",
  tableMaxRows: 8,
  tableMaxCols: 23,
  maxChars: 4000,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
  maxChars: 2000,
});

console.log(JSON.stringify({
  sheets: sheets.ndjson,
  summaryPreview: summary.ndjson.slice(0, 1200),
  detailPreview: detail.ndjson.slice(0, 1200),
  errors: errors.ndjson,
}, null, 2));
