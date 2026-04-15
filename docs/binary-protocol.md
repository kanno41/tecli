# Costpoint Binary Protocol Reference

A complete reverse-engineered specification of the Deltek Costpoint web framework's binary protocol, as implemented by `MasterServlet.cps`. This protocol powers all data exchange between the Costpoint browser client and the Java application server. It predates REST/JSON conventions entirely — everything is encoded in a compact, custom binary-text hybrid format designed to minimize payload size over early-2000s enterprise networks.

---

## Table of Contents

1. [Transport Layer](#transport-layer)
2. [Session Lifecycle](#session-lifecycle)
3. [Request Format](#request-format)
4. [Command Codes](#command-codes)
5. [Command Parameters](#command-parameters)
6. [Row Data Encoding (PUT format)](#row-data-encoding-put-format)
7. [Response Format](#response-format)
8. [Response Data Decoding](#response-data-decoding)
9. [Record Sets and Keys](#record-sets-and-keys)
10. [Edit Flags](#edit-flags)
11. [Row Numbering](#row-numbering)
12. [Column Layout — Parent (K0)](#column-layout--parent-k0)
13. [Column Layout — Child (K1, TMMTS_TS_LINE)](#column-layout--child-k1-tmmts_ts_line)
14. [Column Layout — Charge Lookup (K2)](#column-layout--charge-lookup-k2)
15. [Column Layout — Revision (K2/K3)](#column-layout--revision-k2k3)
16. [Column Layout — Leave Balances (K2/K3)](#column-layout--leave-balances-k2k3)
17. [Timesheet Status Codes](#timesheet-status-codes)
18. [Operational Flows](#operational-flows)
    - [Authentication & Init](#authentication--init)
    - [Cell Edit](#cell-edit)
    - [Save](#save)
    - [Sign](#sign)
    - [Add Project Line](#add-project-line)
    - [Multi-Charge Resolution](#multi-charge-resolution)
    - [Revision Explanation](#revision-explanation)
    - [Leave Balances](#leave-balances)
    - [Previous Period Fetch](#previous-period-fetch)
19. [Password Encoding](#password-encoding)
20. [SSO / SAML Authentication](#sso--saml-authentication)
21. [Production Gotchas](#production-gotchas)

---

## Transport Layer

All protocol traffic is HTTP POST to a single endpoint:

```
POST /cpweb/MasterServlet.cps
Content-Type: application/x-www-form-urlencoded
```

The server runs inside a Java servlet container. The client (normally an iframe-based JS app, but we replicate it with Node.js) sends batches of commands in a single HTTP request and receives a JavaScript array response.

Required headers for servlet requests (WAF/gateway enforcement):

```
Accept: */*
Referer: {baseUrl}/cpweb/masterPage.htm
Origin: {baseUrl}
Sec-Fetch-Dest: empty
Sec-Fetch-Mode: cors
Sec-Fetch-Site: same-origin
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...
```

The `User-Agent` must impersonate a real browser. The `Sec-Fetch-*` headers are checked by the gateway's ISAPI filter.

---

## Session Lifecycle

### Session ID (`sid`)

Every request carries a `sid` parameter. The flow:

1. Client generates a random UUID (stripped of hyphens) as an initial `sid`.
2. After Costpoint login (`LoginServlet.cps`), the client GETs `/cpweb/masterPage.htm`.
3. The server sets a `ProcIdSeed` cookie — this becomes the real `sid` for all subsequent requests.
4. All servlet requests use `sid={ProcIdSeed value}`.

### Keep-Alive

CMD 507 is a no-op keep-alive. It is appended to nearly every batch to prevent server-side session timeout. The framework bookends most batches with it:

```
507 → KEEPALIVE
```

### Cookie Management

The client must implement full RFC 6265 cookie management:

- Track `Set-Cookie` headers per hostname.
- Respect `Path` scoping — cookies are only sent when the request path starts with the cookie's path.
- Handle cookie deletion via `Expires` in the past.
- Maintain separate cookie jars per hostname (critical for SSO flows with Okta, SAML proxies, and the Costpoint gateway).

### Connection Pooling

HTTP keep-alive agents (`keepAlive: true`) are used for connection reuse, mirroring browser behavior. Both HTTP and HTTPS agents are maintained.

---

## Request Format

The POST body is URL-encoded with five parallel arrays, plus the session ID:

```
sid={sid}
&cmd={cmd_field}
&objId={objid_field}
&editFlag={editflag_field}
&rowNumber={rownumber_field}
&data={data_field}
```

Each field contains entries for every command in the batch, separated by `K\x01` (the record-set delimiter, `DLM_RS`). The arrays are positionally aligned — entry N of `cmd` corresponds to entry N of `data`, etc.

Optional trailing parameters:

- `&reqIdx=N` — tells the server which command's record set is the "action context" for CMD 300 actions (e.g., `reqIdx=1` for K1, `reqIdx=2` for K2).
- `&autocompletefl=Y` — for autocomplete data fetches.
- `&LOGININFO=Y&PHONE=N` — for the login-info handshake.

### Batch Example

A save operation sends 7 commands in one HTTP request:

```
cmd = {205 PUT K0}K\x01{205 PUT K1}K\x01{206 SAVE}K\x01{204 K0+}K\x01{204 K0-}K\x01{204 K1+}K\x01{204 K1-}K\x01{507}K\x01
objId = K\x01K\x01K\x01K\x01K\x01K\x01K\x01K\x01
editFlag = 65562,K\x01{per-row flags}K\x01K\x01...
rowNumber = 0,K\x01{per-row nums}K\x01K\x01...
data = {encoded parent row}R\x02K\x01{encoded child rows}R\x02K\x01K\x01...
```

---

## Command Codes

| Code | Name | Purpose |
|------|------|---------|
| 101 | OPEN_APP | Open the application (TMMTIMESHEET). First command after login. |
| 201 | OPEN_RS | Open a record set (e.g., TMMTS, TMMTS_TS_LINE, TC_UDT02_CHARGE_LKP). |
| 204 | GET_DATA | Fetch rows from an open record set. Supports ranges, types, filters. |
| 205 | PUT | Send row data to the server (cell edits, row state). |
| 206 | SAVE | Commit all PUT data to the database. |
| 208 | VALIDATE | Server-side field validation (e.g., validate a project code). |
| 215 | CLOSE_RS | Close a record set. |
| 221 | GET_MSG | Fetch localized message text by metadata keys. |
| 300 | ACTION | Trigger a server-side action (e.g., TMMTS_NEW_TS_LINE, TC_TS_CHARGE_LKP_OK). |
| 507 | KEEPALIVE | Session keep-alive ping. |

### Building a Command String

Each command is encoded as:

```
{reqCd}A{appId}C\x05D{params}C\x05
```

Where:
- `reqCd` — numeric command code (101, 204, etc.)
- `appId` — always `TMMTIMESHEET` for the timesheet app
- `C\x05` — command delimiter (`DLM_CMD`)
- `D` — prefix for the parameter block
- `params` — concatenated parameter entries

---

## Command Parameters

Parameters come in two forms:

### Positional (code-based)

```
{code}{value}P\x07
```

Single-letter codes with their values:

| Code | Meaning | Example Values |
|------|---------|----------------|
| K | Record set key | 0 (parent), 1 (child), 2 (lookup/revision), 3 (audit/detail) |
| I | Record set ID | TMMTS, TMMTS_TS_LINE, TC_UDT02_CHARGE_LKP, TMMTS_TS_REVISION_EXP |
| N | Record set number | 17028 (TMMTS), 17029 (TMMTS_TS_LINE), 22410 (revision), 22411 (audit) |
| T | Record set type | H (header), D (detail) |
| P | Parent key | 0, 1, 2 (which parent RS this is a child of) |
| C | Cursor position | 0, -60000 (initial), -59999 (new row) |
| X | Parent row index | 0, 1 (which parent row to get children for) |
| V | Valid flag | "true" |
| R | Range type | ABS (absolute), HLKP (lookup) |
| S | Start row | 0, -59999 |
| E | End row | 40, -59959, 100 |
| W | WHERE clause | Filter string for HLKP queries |
| G | Generate flag | "false" |
| U | Update flag | "true" |
| L | Lookup level | 16 |

### Named Parameters

```
${name}$N\x08{value}P\x07
```

| Name | Purpose |
|------|---------|
| rsType | Row set type: M (master), SR (sub-record), L (lookup) |
| objectId | Field being validated (e.g., UDT02_ID, DAY4_HRS) |
| actionId | Action name for CMD 300 (TMMTS_NEW_TS_LINE, TC_TS_CHARGE_LKP_OK) |
| lastPutId | Incrementing counter per-session, tracks PUT ordering |
| checkCache | Hash of previous response for cache validation (Java String.hashCode()) |
| rsContextOnly | "Y" — PUT is context-only, not a data mutation |
| rsRowSelectedFlOnly | "true" — PUT only marks a row as selected (for lookups) |
| mobileMode | "N" |
| restartFl | "false" |
| longRunActionFl | "0" |
| procUniqueId | "{appId}:A:{sid}:{N}" — unique process identifier |
| psSchWorkflowNotifyFl | "false" |
| nonDBSize | Number of non-DB (computed) columns |
| nonDBStart | Starting index of non-DB columns |
| newQry | "Y" — new query for negative-range 204s |
| metaData | Comma-separated message key list for CMD 221 |
| syncRequest | "true" |

---

## Row Data Encoding (PUT format)

Row data sent via CMD 205 PUT uses a length-prefixed encoding. Each field in the row is encoded sequentially:

### Encoding Rules

```
Empty string (null) → '0'
Runs of 4+ empties → '?' + digitCount + count
Length 1-26         → chr(64 + length) + value
Length 27-52        → chr(70 + length) + value
Length 53+          → digitCount + length + value
```

### Examples

| Input | Encoded |
|-------|---------|
| `""` | `0` |
| `""` x 10 | `?210` |
| `"8"` | `A8` (chr(65) = 'A', length 1) |
| `"ZLEAVE.CMP"` | `JZLEAVE.CMP` (chr(74) = 'J', length 10) |
| `"Regular Hours"` | `Nregular Hours` (chr(78) = 'N', length 14) |

### Row Separator

Multiple rows in a single PUT are separated by `R\x02` (`DLM_ROW`). A single-row PUT also uses a trailing `R\x02`:

```
data = {encodedRow1}R\x02{encodedRow2}R\x02
```

### Edit Flags and Row Numbers

The `editFlag` and `rowNumber` fields are comma-separated lists matching the rows in `data`:

```
editFlag = 18,18,19,
rowNumber = 0,1,-59999,
```

---

## Response Format

The server response is a JavaScript assignment:

```javascript
var responses=[{frame_array}, {rescds_string}, {data_array}, {error_array}];
```

This is parsed by `eval`-ing it with stubs for browser globals (`parent`, `D`, `g`) that the server-side JS may reference.

### Response Structure

| Index | Content | Type |
|-------|---------|------|
| `[0]` | Frame status array | `string[]` |
| `[1]` | Result codes (`rescds`) | `string` |
| `[2]` | Data slots | `array[]` |
| `[3]` | Error/status array | `(string \| array)[]` |

### Frame Status Array (`responses[0]`)

Each entry describes one command result:

```
"TMMTIMESHEET|{rsKey}|{cmdCd}|{dataStart}|{dataEnd}|{changedFl}|{deletedFl}"
```

- `rsKey` — which record set (0, 1, 2, 3)
- `cmdCd` — which command code produced this frame (204, 205, 206, etc.)
- `dataStart`, `dataEnd` — index range into the data array

### Result Codes (`responses[1]`)

A concatenated string with one character per frame. `"0"` means success. `"-1"` means error (e.g., save rejected, revision explanation required). Parse by walking the string — a `-` character starts a negative number consuming two characters.

### Error Array (`responses[3]`)

Per-frame error status. Each entry is:

- `"<OK>"` — success
- `"<NO DATA>"` — no data returned (not an error)
- `string` — error message
- `[["message", ["detail1", "detail2"]]]` — structured error with details

---

## Response Data Decoding

CMD 204 responses return data in slot format:

```
dataSlot = [unknown, rowNums, rowFlags, maxWidths, compressedData]
```

### Row Number Decoding

Row numbers are a comma-separated string with optional ranges:

```
"0,1,2,3" → [0, 1, 2, 3]
"0\x0F3"  → [0, 1, 2, 3]  (range: 0 through 3)
```

The `\x0F` character (`ENCODE_RANGE_DELIM`) marks ranges.

### Row Flag and Width Decoding

These use run-length encoding (see below) followed by `decodeStr` for back-references.

### Data Decoding (the main compression scheme)

The compressed data string uses six special characters:

| Char | Hex | Name | Purpose |
|------|-----|------|---------|
| `\x0B` | 0x0B | ENCODE_COMMA | Field separator (replaces literal commas) |
| `\x06` | 0x06 | ENCODE_NULL | Empty string marker |
| `\x07` | 0x07 | ENCODE_PREV_FOUND | Reference to a previous row's value |
| `\x05` | 0x05 | ENCODE_RUN_LEN | Run-length encoded empty fields |
| `\x0E` | 0x0E | ENCODE_PREV_SUBSTR | Substring of previous row's value |
| `\x0F` | 0x0F | ENCODE_RANGE_DELIM | Range delimiter in number sequences |

### Decoding Steps

1. **Run-length expansion** (`decodeRunLen`):
   - Split on `\x05` (run-length marker).
   - Decode the count (using `decodeSmallNumber` on the next character).
   - Expand into that many empty field separators.

2. **Field splitting**: Split expanded string on `\x0B` (field separator).

3. **First field extraction**: The first field contains `{numCols},{firstFieldValue}` — parse the column count, then replace the entry with just the first field value.

4. **Per-cell decompression** (`decodeStr`): For each cell in left-to-right, top-to-bottom order:
   - Empty string + row > 0 → copy from same column in previous row
   - `\x06` → empty string (explicit null)
   - `\x07{N}` → copy from N rows back (small number encoded)
   - `\x0E{N}{suffix}` → take first N chars from previous row's same column, append suffix

### Small Number Encoding

Characters are mapped to numbers via an offset scheme (ported from Costpoint's MasterPage.js):

```javascript
function decodeSmallNumber(charCode) {
  let idx = charCode;
  if (idx >= 92) idx--;   // skip backslash
  if (idx >= 60) idx--;   // skip '<'
  if (idx >= 39) idx--;   // skip single quote
  if (idx >= 34) idx--;   // skip double quote
  return idx - 32;
}
```

This maps printable ASCII starting at space (32) to 0, skipping characters that would break HTML/JS parsing (`"`, `'`, `<`, `\`).

### Compound Numbers

Large numbers use multiple characters separated by `\x0F`:

```
{char1}\x0F{char2} → decodeSmallNumber(char1) + decodeSmallNumber(char2)
```

---

## Record Sets and Keys

The protocol uses a hierarchical record set model:

| Key | Record Set ID | N | Description |
|-----|---------------|---|-------------|
| K0 | TMMTS | 17028 | Parent — timesheet header (one row per pay period, up to 14) |
| K1 | TMMTS_TS_LINE | 17029 | Child — timesheet lines (project rows, hours, comments) |
| K2 | *(varies)* | *(varies)* | Secondary — used for charge lookups, revision explanations, leave balances |
| K3 | *(varies)* | *(varies)* | Tertiary — used for audit details, leave detail lines |

### K2/K3 Usage by Context

| Operation | K2 | K3 |
|-----------|----|----|
| Charge lookup | TC_UDT02_CHARGE_LKP (N=0) | — |
| Revision explanation | TMMTS_TS_REVISION_EXP (N=22410) | TMMTS_TS_AUDIT_EXP (N=22411) |
| Leave balances | TMMTS_LVSTAT_HDR (N=17314) | TMMTS_LV_STAT (N=17315) |

### Record Set Types

| Type Code | Meaning |
|-----------|---------|
| H | Header (parent RS) |
| D | Detail (child RS) |
| M | Master data query |
| SR | Sub-record query |
| L | Lookup query |

### 204 Range Requests

Data is fetched in two passes per record set:

1. **Positive range**: `S=0, E=40` — existing rows (row numbers 0, 1, 2...)
2. **Negative range**: `S=-59999, E=-59959` — new/pending rows (row numbers -59999, -59998...)

Both are merged client-side. The `X` parameter specifies which parent row to fetch children for (X=0 for current period, X=1 for previous).

---

## Edit Flags

Edit flags tell the server how to treat each row in a PUT:

| Flag | Meaning | Usage |
|------|---------|-------|
| 1 | New row (INSERT) | Rarely used directly |
| 18 | Modified existing row | Cell edits, existing row saves |
| 19 | New row with data | New timesheet line being added |
| 64 | Lookup row | Selected charge from K2 lookup |
| 65562 | Parent during save | Parent row (K0) in save batches |
| 65619 | Revision explanation row | K2 row during revision save |

---

## Row Numbering

| Range | Meaning |
|-------|---------|
| 0, 1, 2, ... | Existing rows (server-assigned) |
| -59999 | New row (first pending insert) |
| -59998, -59997, ... | Additional new rows |
| -60000 | Initial cursor position (used in OPEN_RS) |

---

## Column Layout — Parent (K0)

The parent record set contains timesheet header information. One row per available pay period (up to 14 rows, newest first).

| Column | Field | Description |
|--------|-------|-------------|
| 0 | EMPL_FULL_NAME | Employee's full name |
| 1 | EMPL_ID | Employee ID |
| 2 | SCHEDULE_DESC | Pay schedule description (contains "Wk N of M") |
| 3 | END_DT | Period end date (used to compute day columns) |
| 4 | S_STATUS_CD | Timesheet status code (A/M/O/P/R/S) |
| 565 | ENABLE_SIGN_FL | Whether signing is enabled for this period |
| 667 | ACTION_CD | Set to "S" to trigger sign on save |

---

## Column Layout — Child (K1, TMMTS_TS_LINE)

Each child row is a timesheet line (one project). The row has **402 columns**.

### Key Columns

| Column | Field | Description |
|--------|-------|-------------|
| 0 | STATUS | Row status |
| 1 | SEQ_NO | Sequence/line number |
| 2 | LINE_DESC | Project description |
| 4 | CHARGE_ID (UDT01_ID) | Charge identifier (e.g., ZTC-DL-000-0000). **Must be kept in PUT data** — clearing causes "Account required" |
| 6 | UDT02_ID | Project code (e.g., ZLEAVE.CMP) |
| 8 | UDT03_ID (PLC) | Project Labor Category |
| 14 | ACCOUNT | Account (populated by server after charge resolution) |
| 16 | PAY_TYPE (UDT10_ID) | Pay type (e.g., REG, RHB). **Must NOT be manually set for multi-charge codes** |
| 17 | WORK_LOCATION | Work location |
| 96 | TOTAL_ENTERED | Computed total hours for the row |
| 101 | LEAVE_TYPE1 | Leave type |
| 105 | PROJECT2 | Secondary project reference |
| 113 | COMMENT___DATA_ROW | Row-level comment |

### Hours Columns (DAY1-DAY7, weekly view)

| Day | Hours Column | Comment Column | Comment Field Name |
|-----|-------------|----------------|-------------------|
| 1 (Mon) | 26 | 124 | COMMENT___DAY1_HRS |
| 2 (Tue) | 27 | 135 | COMMENT___DAY2_HRS |
| 3 (Wed) | 28 | 143 | COMMENT___DAY3_HRS |
| 4 (Thu) | 29 | 144 | COMMENT___DAY4_HRS |
| 5 (Fri) | 30 | 145 | COMMENT___DAY5_HRS |
| 6 (Sat) | 31 | 146 | COMMENT___DAY6_HRS |
| 7 (Sun) | 32 | 147 | COMMENT___DAY7_HRS |

Note: Comment columns are NOT sequentially numbered. The mapping was discovered from the live Costpoint JS `objEnum` mapping. The alphabetical sort of field names (`COMMENT___DAY10_HRS` < `COMMENT___DAY1_HRS` < `COMMENT___DAY2_HRS`) causes non-sequential column assignment.

### Extended Days (DAY8-DAY35, biweekly/monthly)

| Day | Comment Column |
|-----|---------------|
| 8 | 148 |
| 9 | 149 |
| 10 | 114 |
| ... | (continues non-sequentially) |

### Template Columns (copied when creating new rows)

These columns carry employee defaults and must be copied from an existing row when creating a new one:

```
0, 150, 151, 187, 193, 194, 197, 234, 235, 336, 398
```

### New Row Columns

| Column | Value | Purpose |
|--------|-------|---------|
| 1 | next seq number | Sequence number |
| 198 | next seq number | Duplicate seq number |
| 196 | "N" | New row flag |
| 393 | "N" | New row flag (duplicate) |

### Charge Resolution Columns (K2 -> K1 copy)

After charge lookup, these fields are copied from the K2 lookup row into the K1 child row:

| K1 Column | K2 Column | Field |
|-----------|-----------|-------|
| 104 | 5 | Project code |
| 108 | 24 | Combined code+payType (e.g., ZLEAVE.FTBRHB) |
| 112 | 26 | Flag |
| 376 | 15 | Pay type |
| 400 | 32 | Project code |

### Source Code Columns

| Column | Value |
|--------|-------|
| 321 | SOURCE_CD S |
| 322 | SOURCE_CD C |
| 323 | SOURCE_CD E |

---

## Column Layout — Charge Lookup (K2)

The K2 charge lookup RS (`TC_UDT02_CHARGE_LKP`) returns available charges for a project code:

| Column | Field |
|--------|-------|
| 5 | Project code |
| 15 | PAY_TYPE (used for matching) |
| 24 | Combined code+payType (e.g., ZLEAVE.FTBRHB) |
| 26 | Flag |
| 32 | Project code (duplicate) |

### HLKP WHERE Clause Format

The filter for HLKP (helper lookup) queries:

```
1|C^UDT02_ID^9^{code}^0|C^$H_LKP_SEL_LVL$^1^1^0|C^$H_LKP_SEL_ROW$^1^-2^0|
```

Format: `{count}|{type}^{field}^{len}^{value}^{flags}|...`

---

## Column Layout — Revision (K2/K3)

### K2: TMMTS_TS_REVISION_EXP (9 columns)

| Column | Field |
|--------|-------|
| 0 | EXPLANATION_TEXT |
| 1 | REVISION_NO |
| 2 | (empty) |
| 3 | (empty) |
| 4 | CANCELLED_CD (always "N") |
| 5 | EMPL_ID |
| 6 | PERIOD_NO_CD |
| 7 | TS_SCHEDULE_CD |
| 8 | YEAR |

### K3: TMMTS_TS_AUDIT_EXP (18 columns)

| Column | Field |
|--------|-------|
| 0 | REVISION_NO |
| 1 | LINE_NO |
| 2 | HRS_DT (date) |
| 3 | UDT02_ID (project) |
| 5 | Account |
| 6 | Charge description |
| 7 | Audit detail (e.g., "Changed Hours From 6.0 to 5.5") |

---

## Column Layout — Leave Balances (K2/K3)

### K2: TMMTS_LVSTAT_HDR

| Column | Field |
|--------|-------|
| 0 | Description |
| 1 | Balance (numeric) |
| 2 | Leave type code |

### K3: TMMTS_LV_STAT

| Column | Field |
|--------|-------|
| 0 | Date |
| 1 | Type |
| 2 | Hours |
| 3 | Reason |
| 4 | Leave type code |
| 5 | Leave type description |

---

## Timesheet Status Codes

| Code | Label |
|------|-------|
| A | Approved |
| M | Missing |
| O | Open |
| P | Processed |
| R | Rejected |
| S | Signed |

Read from parent K0, column 4 (`S_STATUS_CD`).

---

## Operational Flows

### Authentication & Init

The full init sequence from cold start:

```
1. GET  /cpweb/cploginform.htm?system={system}
   → May redirect to Okta SSO (see SSO section)
   → Establish gateway identity

2. POST /cpweb/LoginServlet.cps  (requestCd=000)
   → Establish connection

3. POST /cpweb/LoginServlet.cps  (requestCd=003, DATABASE, LANG, FIDO_CONFIG)
   → Auth configuration

4. POST /cpweb/LoginServlet.cps  (USER, P_FL=Y, DATABASE, ...)
   → Returns copyAuthData JSON with { userId, nonce, ldapAuthFl, sha2PasswordFl }

5. POST /cpweb/LoginServlet.cps  (PASSWORD={encrypted})
   → AES-128-CBC encrypted password (see Password Encoding)

6. GET  /cpweb/masterPage.htm
   → Captures ProcIdSeed cookie → becomes sid

7. POST MasterServlet.cps  (sid, LOGININFO=Y, PHONE=N)
   → Login info handshake

8. POST MasterServlet.cps  [507 + 101 OPEN_APP + 507]
   → Open application, save response for checkCache

9. POST MasterServlet.cps  [201 OPEN_RS K0 + 507]
   → Open parent record set (TMMTS), save response for checkCache

10. POST MasterServlet.cps  [204 K0+ + 204 K0- + 201 OPEN_RS K1 + 507]
    → Fetch parent data + open child record set (TMMTS_TS_LINE)

11. POST MasterServlet.cps  [204 K1+ + 204 K1- + 507]
    → Fetch child data (timesheet lines) for current period (X=0)
```

### Cell Edit

Editing a single cell (e.g., setting hours for a day):

```
Batch: [205 PUT K1 + 208 VALIDATE + 204 K0+ + 204 K0- + 204 K1+ + 204 K1- + 507]

205 PUT K1:
  - Full row data encoded with encodePutRow()
  - editFlag: 18 (existing) or 19 (new)
  - rowNumber: the row being edited

208 VALIDATE:
  - objectId: "DAY{N}_HRS" (e.g., DAY4_HRS for Thursday)
  - K=1, server validates the cell value

204 refreshes:
  - Re-fetch both K0 and K1 (positive + negative ranges)
  - Merge response back into local state
```

### Save

```
Batch: [205 PUT K0 + 205 PUT K1 + 206 SAVE + 204 K0+ + 204 K0- + 204 K1+ + 204 K1- + 507]

205 PUT K0:
  - Parent row, editFlag=65562

205 PUT K1:
  - ALL child rows in one PUT
  - Each row encoded, separated by R\x02
  - editFlag per row: 18 (existing), 19 (new)
  - rowNumber per row: comma-separated list

206 SAVE:
  - G=false, C=0, U=true, K=0, V=true
  - Targets K0 (parent) which cascades to children

204 refreshes:
  - Re-fetch all data after save
```

**Response checking:**

1. Check `rescds` for `-1` — if CMD 206 frame has -1, save was blocked.
2. Check errors array for error messages.
3. If -1 on save: likely requires revision explanation (see below).
4. On success: merge K0/K1 204 data back to local state.

### Sign

Signing is done by setting ACTION_CD and saving:

```
1. Set parentData.rows[0][667] = "S"  (ACTION_CD column)
2. Execute normal save flow
```

The server interprets ACTION_CD="S" as a sign request.

### Add Project Line

Full 5-step flow for adding a new timesheet line:

#### Step 1: Create Local Row + CMD 300 TMMTS_NEW_TS_LINE

```
Local preparation:
  - new Array(402).fill('')
  - Copy template cols (0, 150, 151, 187, 193, 194, 197, 234, 235, 336, 398) from existing row
  - Set col[1] = col[198] = next sequence number
  - Set col[196] = col[393] = "N"
  - Append to childData with rowNum=-59999, rowFlag=19

Batch: [205 PUT K0 + 205 PUT K1 + 205 PUT K0 ctx + 205 PUT K1 ctx + 300 TMMTS_NEW_TS_LINE + 204 K0+ + 204 K0- + 204 K1+ + 204 K1- + 507]
  + &reqIdx=1

CMD 300 params:
  - actionId: TMMTS_NEW_TS_LINE
  - restartFl: false
  - C: {rowNum} (-59999)
  - K: 1, P: 0
  - procUniqueId: TMMTIMESHEET:A:{sid}:1
  - (plus action boilerplate params)
```

The "context" PUTs (`rsContextOnly=Y`) inform the server of the current state without modifying data. The server uses this to populate employee defaults on the new row.

#### Step 2: Set Project Code + Validate

```
Batch: [205 PUT K1 + 205 PUT K1 ctx + 208 VALIDATE UDT02_ID + 204 K0+ + 204 K0- + 204 K1+ + 204 K1- + 507]

- Set col[6] (UDT02_ID) = project code (e.g., "ZLEAVE.FTB")
- 208 VALIDATE objectId=UDT02_ID
- "More than one charge found" error is EXPECTED for multi-charge codes (not fatal)
```

#### Step 3: Resolve Charge (see Multi-Charge Resolution below)

#### Step 4: Post-Charge Validate

```
Same as Step 2 — another 205+208 VALIDATE cycle.
Finalizes the charge in server session. Without this, Account field
is not committed, causing "Account required" on save.
```

#### Step 5: Save

Normal save flow with editFlag=19 for the new row.

### Multi-Charge Resolution

When a project code has multiple charge entries (e.g., ZLEAVE.FTB has REG and RHB), the server requires explicit charge selection via a 3-step lookup:

#### Step 1: Open K2 Charge Lookup RS

```
Batch: [205 PUT K1 + 201 OPEN_RS K2 + 507]

201 OPEN_RS:
  - K=2, I=TC_UDT02_CHARGE_LKP, N=0, L=16
  - P=1 (parent is K1)
  - objectId=UDT02_ID
```

#### Step 2: HLKP Query

```
Batch: [204 HLKP K2+ + 204 HLKP K2- + 507]

204 params:
  - rsType=L (lookup)
  - R=HLKP
  - W= filter clause (see HLKP WHERE format above)
  - objectId=UDT02_ID
  - X=-59999 (new row context)

Response: K2 204 data with one row per available charge.
  - col[15] = PAY_TYPE (used for selection)
  - col[24] = combined code+payType
```

#### Step 3: CMD 300 TC_TS_CHARGE_LKP_OK

Before sending CMD 300, copy fields from selected K2 row to K1 child row:

```
K1[104] ← K2[5]    (project code)
K1[108] ← K2[24]   (combined code+payType)
K1[112] ← K2[26]   (flag)
K1[376] ← K2[15]   (pay type)
K1[400] ← K2[32]   (project code)
```

Then send the 14-command batch:

```
Batch: [
  205 PUT K2 selected (rsRowSelectedFlOnly, editFlag=64),
  205 PUT K1 child (editFlag=19),
  205 PUT K2 selected (editFlag=64),
  205 PUT K1 child ctx (rsContextOnly),
  205 PUT K0 parent ctx (rsContextOnly, editFlag=65562),
  205 PUT K2 selected ctx (rsContextOnly, editFlag=64),
  300 TC_TS_CHARGE_LKP_OK,
  204 K0+, 204 K0-,
  204 K1+, 204 K1-,
  204 K2+, 204 K2-,
  507
] + &reqIdx=2

CMD 300 params:
  - actionId: TC_TS_CHARGE_LKP_OK
  - K=2, P=1
  - procUniqueId: TMMTIMESHEET:A:{sid}:2
```

### Revision Explanation

When saving changes to a previously-processed timesheet, the server may require an explanation.

#### Detection

CMD 206 SAVE returns result code `-1` in rescds. `checkErrors()` may or may not return an error message ("Explanation or Reject Reason is required").

#### Flow

```
1. Detect -1 on CMD 206 frame → revision required

2. POST [201 OPEN_RS K2 (TMMTS_TS_REVISION_EXP, N=22410) + 507]

3. POST [204 K2+ (SR type) + 204 K2- + 201 OPEN_RS K3 (TMMTS_TS_AUDIT_EXP, N=22411, P=2) + 507]

4. POST [204 K3+ + 204 K3- + 507]
   → Returns audit detail rows (18 cols each):
     col[0]=REVISION_NO, col[2]=date, col[3]=project, col[7]=detail text

5. POST [
     205 PUT K2 (rsRowSelectedFlOnly, editFlag=65619),
     205 PUT K2 (data with lastPutId, editFlag=65619),
     205 PUT K2 (data with lastPutId, editFlag=65619),
     206 SAVE,
     204 K0+, 204 K0-,
     204 K1+, 204 K1-,
     507
   ]
   → K2 row data: [explanation, revisionNo, "", "", "N", emplId, periodNoCd, scheduleCd, year]
   → Server already has K0/K1 data from first save — no need to re-PUT them
```

### Leave Balances

```
1. POST [201 OPEN_RS K2 (TMMTS_LVSTAT_HDR, N=17314, P=0) + 507]

2. POST [204 K2+ + 204 K2- + 201 OPEN_RS K3 (TMMTS_LV_STAT, N=17315, P=2) + 507]
   → K2 data: leave type summaries (description, balance, code)

3. POST [204 K3+ + 204 K3- + 507]
   → K3 data: detail transactions (date, type, hours, reason)
   → X parameter selects which K2 parent row (leave type) to get details for
```

### Previous Period Fetch

For biweekly pay periods, fetching the other week requires re-establishing the app state to avoid server cache conflicts:

```
1. Re-open app with checkCache (Java String.hashCode() of previous OPEN_APP response)
   → [507 + 101 OPEN_APP (checkCache=hash) + 507]

2. JSON POST: getHistoryData for TMMTS
   → {"ProcIdSeed": sid, "requests": [{"getHistoryData": {"appId": "TMMTIMESHEET", "rsId": "TMMTS", "rsKeyLkpHist": -1}}]}

3. Re-open parent RS with checkCache (hash of previous OPEN_RS response)
   → [201 OPEN_RS K0 (checkCache=hash) + 507]

4. JSON POST: getHistoryData for TMMTS_TS_LINE

5. Re-fetch parent data + open child RS (same as init step 10)

6. Autocomplete fetch (rsType=M, R=AUTO, W=$N$|1:20|0|)

7. Fetch X=0 child data (re-prime)

8. CMD 221 message fetch (metaData=TC_UNSAVED_DATA,#TM_APPROVE_TEXT,...)

9. Finally: Fetch X=1 child data
   → [204 K1+ (X=1) + 204 K1- (X=1) + 507]
   → nonDBSize=9, nonDBStart=0 on positive range
```

The `checkCache` parameter uses Java's `String.hashCode()`:

```javascript
function javaHashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
```

---

## Password Encoding

Costpoint uses AES-128-CBC encryption for password transmission, matching the logic in `cploginform.js`.

### LDAP Mode (`ldapAuthFl=1`)

```
plaintext = password + "<;$/" + nonce + "<;$/" + timestamp
key       = SHA-256(userId + nonce).substring(0, 32)  → 16 bytes (hex decoded)
```

### Native Mode (`ldapAuthFl=0`)

```
# SHA-2 mode (sha2PasswordFl=1):
pass  = SHA-256(SHA-256(password))
hash1 = SHA-256(userId + pass)
key   = SHA-256(hash1).substring(0, 32)

# SHA-1 mode (sha2PasswordFl=0):
pass  = SHA-1(SHA-1(password))
hash1 = SHA-1(userId + pass)
key   = SHA-1(hash1).substring(0, 32)

plaintext = hash1 + nonce + timestamp
```

### Encryption

```
IV        = "1111111111111111" (16 bytes of 0x31)
Padding   = '!' characters to AES block boundary (16 bytes), then PKCS7
Algorithm = AES-128-CBC
Output    = hex-encoded ciphertext
```

---

## SSO / SAML Authentication

When the Costpoint gateway is configured for SSO (e.g., Okta), the init flow changes:

### Detection

The initial GET to `cploginform.htm` returns a 302 redirect to an external hostname (e.g., Okta).

### Okta IDX Flow

```
1. GET {samlUrl}
   → Extract stateToken from HTML/JS: "stateToken":"..."
   → Decode JS escapes (\x2D → '-')

2. POST /idp/idx/introspect  (JSON: { stateToken })
   → Returns { stateHandle }

3. POST /idp/idx/identify  (JSON: { identifier: username, stateHandle })
   → Returns remediation form (challenge-authenticator or select-authenticator-authenticate)

4. If select-authenticator-authenticate:
   → Find password authenticator by type="password"
   → POST select form with { authenticator: { id }, stateHandle }
   → Get challenge-authenticator form

5. POST /idp/idx/challenge/answer  (JSON: { credentials: { passcode: password }, stateHandle })
   → Returns success redirect URL

6. Follow SAML chain:
   → GET redirect URL
   → Parse SAMLResponse forms
   → POST each form (up to 10 hops through SAML proxies)
   → Each hop: extract <form action="...">, collect hidden <input> fields, POST
   → Only forms with SAMLResponse input are SAML forms (vs. gateway replay forms)
```

### SAML Form Chain

After SSO authentication, the browser follows a chain of auto-submit forms. Each form contains `SAMLResponse` and sometimes `RelayState` fields. The chain may traverse multiple domains (Okta -> SAML proxy -> gateway -> Costpoint).

### Transparent Re-authentication

After the identity SAML chain is established, subsequent requests to `/cpweb/*` may trigger app-specific SAML redirects. The HTTP layer (`_http()`) detects these transparently:

1. Response is a 302 redirect to an external hostname.
2. Follow the SAML chain (already authenticated, so Okta returns a SAML form immediately).
3. Retry the original request.

---

## Production Gotchas

### CHARGE_ID Must Be Kept

Column 4 (`CHARGE_ID` / `UDT01_ID`) in child rows is populated by the server after charge resolution. Once set, it **must be included in all subsequent PUT data**. Clearing it causes "Account required" errors on save.

### PAY_TYPE Must Not Be Manually Set for Multi-Charge Codes

Column 16 (`PAY_TYPE` / `UDT10_ID`) must **not** be manually set when adding multi-charge project codes. The server populates it during charge resolution. Manually setting it causes "This Pay Type cannot be manually entered" errors.

### Known Charge IDs

| Code Pattern | CHARGE_ID |
|-------------|-----------|
| ZLEAVE.* (leave codes) | ZTC-LV-000-0000 |
| Direct labor | ZTC-DL-000-0000 |
| PLC (all) | 43235 |

### Single vs. Multi-Charge Codes

- **Single-charge codes** (e.g., ZLEAVE.HOL): Charge lookup returns exactly 1 row, auto-selected.
- **Multi-charge codes** (e.g., ZLEAVE.FTB): Returns multiple rows (REG, RHB, etc.). The `payType` parameter selects which one.

### Context PUTs

Many batches include "context" PUTs (`rsContextOnly=Y`) in addition to regular PUTs. These inform the server of the current state without triggering data mutation. They are required for actions like CMD 300 to work correctly — the server needs to know the full state across all record sets.

### reqIdx Parameter

CMD 300 actions need `&reqIdx=N` appended to the POST body (not URL-encoded in the main fields). This tells the server which record set key is the action context:

- `reqIdx=1` — K1 (child), used for TMMTS_NEW_TS_LINE
- `reqIdx=2` — K2 (lookup), used for TC_TS_CHARGE_LKP_OK

Without this, the server ignores the K2 row selection in charge lookups.

### Action Boilerplate

CMD 300 actions require a large block of report-related parameters even for non-report actions. These are framework boilerplate that the server expects:

```
rptPrintAllPages=Y, rptInclCoverPage=Y, printRpt=N,
rptScalingFactor=DFLT, rptPrnNofC=1, downloadRpt=Y,
emailRpt=N, printToFileRpt=N, rptLocale=VIEW_AS_BUILT,
runAfterRptFl=Y, archiveRpt=N, rptArchRelativeAbsDt=Y,
rptArchNeverDelete=Y, syncRequest=true, rptFormat=pdf,
printLocalRpt=N, printSendEmail{1-4}=N,
printHomePage{1-4}=N, printPopupAlert{1-4}=N,
rptEmailAttachmentCount=0
```

### `lastPutId` Counter

Every PUT command includes a `lastPutId` named parameter with a monotonically increasing integer. This allows the server to detect duplicate or out-of-order PUTs. The counter is per-session and never resets.

### Java String.hashCode()

The `checkCache` parameter used during re-initialization is the Java `String.hashCode()` of the previous response body. This is a 32-bit hash:

```
hash = 0
for each char c:
  hash = (hash << 5) - hash + charCodeAt(c)
  hash |= 0  // truncate to 32-bit int
```

---

## Protocol Lineage

This protocol originates from Deltek's proprietary web framework, likely developed in the early 2000s for Costpoint 6.x/7.x. Key indicators:

- The response format (`var responses=[...]`) assumes execution in a browser `<script>` tag within an iframe.
- References to `parent` (iframe parent), `D` (framework namespace), and `g` (global) in response JS.
- The compression scheme (run-length encoding, previous-row references, substring deduplication) optimizes for tabular data with high column-to-column and row-to-row repetition.
- The `MasterServlet.cps` endpoint serves as a universal RPC endpoint, with command batching to minimize HTTP round-trips (important in the pre-HTTP/2 era).
- The `LoginServlet.cps` authentication flow supports both native Costpoint passwords and LDAP, with a FIDO/U2F configuration flag.

All protocol knowledge was reverse-engineered by capturing browser traffic from the live Costpoint instance at `te.leidos.com` using Chrome DevTools, then implementing the encode/decode logic in Node.js.
