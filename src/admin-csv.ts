import { privateCorsHeaders } from "./http";

export function adminCsvResponse(
  request: Request,
  allowedOrigins: string,
  {
    filename,
    columns,
    rows
  }: {
    filename: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  }
): Response {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}\.csv$/i.test(filename)) {
    throw new TypeError("A safe CSV filename is required");
  }
  const body = [
    columns.map(adminCsvCell).join(","),
    ...rows.map((row) =>
      columns.map((column) => adminCsvCell(row[column])).join(",")
    )
  ].join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      ...privateCorsHeaders(request, allowedOrigins),
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-expose-headers": "content-disposition",
      "cache-control": "private, no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive"
    }
  });
}

export function adminCsvCell(value: unknown): string {
  let text = Array.isArray(value)
    ? value.join("|")
    : value === null || value === undefined
      ? ""
      : String(value);
  if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
