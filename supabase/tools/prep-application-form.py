# Makes the PDF version of the GBMA application form (REV-FM-GBMA-HR-006) for the HRIS.
# Input: the blank form exported to PDF by Word. Output: hris/application-form.pdf (copy of it) and
# hris/application-form.json = where each answer goes: [key, page, x, baseline y from top, width] in PDF points;
# the family and reference tables' rows (so unused rows can be removed) and the page border.
import json, shutil, sys, pymupdf
SRC, OUTDIR = sys.argv[1], sys.argv[2]
K = ['position','desiredSalary','availableFrom','dateApplied','lastName','firstName','middleName','suffix',
 'presentAddress','height','weight','facebook','mobile','tel','email','age','birthDate','birthPlace',
 'civilStatus','citizenship','religion','gender','sss','tin','philhealth','pagibig','spouseName','spouseOccupation',
 'spouseAddress','childrenCount','childrenList','emName','emRelationship','emAddress','emPhone','currentlyEmployed',
 'formerEmployee','formerWhen','hasRelatives','relatives','overtime','overtimeReason','sundays','sundaysReason']
for lv, extra in [('pri',0),('sec',0),('ter',1),('voc',1),('oth',1)]:
    K += [lv+'School', lv+'Location', lv+'Years'] + ([lv+'Course', lv+'Major'] if extra else []) + [lv+'Honors']
K += ['otherQualifications','equipment','licenses','skills']
for i in range(1, 6): K += [f'w{i}Employer',f'w{i}Location',f'w{i}Title',f'w{i}Nature',f'w{i}Salary',f'w{i}From',f'w{i}To']
K += ['signName']
d = pymupdf.open(SRC); fields = []; blanks = []
for pi, p in enumerate(d):
    for b in p.get_text('rawdict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                cur = None
                for c in s['chars']:
                    if c['c'] != '_': cur = None; continue
                    if cur and abs(c['bbox'][0] - cur[3]) < 1: cur[3] = c['bbox'][2]
                    else: cur = [pi, c['origin'][1], c['bbox'][0], c['bbox'][2]]; blanks.append(cur)
blanks.sort(key=lambda b: (b[0], round(b[1]), b[2]))
assert len(blanks) == len(K), len(blanks)
for k, (pi, y, x0, x1) in zip(K, blanks): fields.append([k, pi, round(x0 + 1, 1), round(y - 1.5, 1), round(x1 - x0 - 2, 1)])
fam = [['fa'], ['mo']] + [[f's{i}'] for i in range(1, 9)]
tabs = [(pi, t) for pi, p in enumerate(d) for t in p.find_tables().tables]
assert len(tabs) == 2
tables = []
def cells(pi, t, rowkeys, cols):
    tables.append({'page': pi, 'keep': 3 if len(rowkeys) > 3 else 1, 'cols': cols,
                   'rows': [[k[0], round(r.bbox[1], 1), round(r.bbox[3], 1)] for r, k in zip(t.rows[1:], rowkeys)]})
    words = d[pi].get_text('words')
    for row, keys in zip(t.rows[1:], rowkeys):
        for (x0, y0, x1, y1), suf in zip(row.cells, cols):
            label = [w for w in words if w[0] >= x0 - 1 and w[2] <= x1 + 1 and w[1] >= y0 - 1 and w[3] <= y1 + 1]
            left = max([w[2] + 3 for w in label] + [x0 + 3])
            fields.append([keys[0] + suf, pi, round(left, 1), round(y1 - 3.5, 1), round(x1 - left - 2, 1)])
cells(*tabs[0], fam, ['Name','Age','Birth','Occupation','Address'])
cells(*tabs[1], [[f'r{i}'] for i in range(1, 4)], ['Name','Occupation','Address','Phone'])
shutil.copy(SRC, OUTDIR + '/application-form.pdf')
# page border: the side bars' x ranges and the top of the bottom bar, from the filled rectangles near the edges
bars = [dr['rect'] for dr in d[0].get_drawings() if dr.get('fill') and (dr['rect'].width > 500 or dr['rect'].height > 500)]
side = sorted([r for r in bars if r.height > 500], key=lambda r: r.x0); bottom = max(r.y0 for r in bars if r.width > 500)
border = {'sides': [[round(r.x0, 1), round(r.x1, 1)] for r in side], 'bottom': round(bottom, 1)}
json.dump({'fields': fields, 'tables': tables, 'border': border}, open(OUTDIR + '/application-form.json', 'w'), separators=(',', ':'))
print(len(fields), 'fields')
