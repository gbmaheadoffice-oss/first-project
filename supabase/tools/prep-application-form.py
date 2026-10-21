# Turns the GBMA application form into a template: every ____ blank becomes {{key|length}} (underlined),
# and the family and reference tables get {{key|0}} in each cell. Output: hris/application-form.docx
import re, sys, zipfile, shutil
SRC, OUT = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(SRC); x = z.read('word/document.xml').decode('utf-8')
K = ['position','desiredSalary','availableFrom','dateApplied','lastName','firstName','middleName','suffix',
 'presentAddress','height','weight','facebook','mobile','tel','email','age','birthDate','birthPlace',
 'civilStatus','citizenship','religion','gender','sss','tin','philhealth','pagibig','spouseName','spouseOccupation',
 'spouseAddress','childrenCount','childrenList','emName','emRelationship','emAddress','emPhone','currentlyEmployed',
 'formerEmployee','formerWhen','hasRelatives','relatives','overtime','overtimeReason','sundays','sundaysReason']
for lv,extra in [('pri',0),('sec',0),('ter',1),('voc',1),('oth',1)]:
    K += [lv+'School',lv+'Location',lv+'Years'] + ([lv+'Course',lv+'Major'] if extra else []) + [lv+'Honors']
K += ['otherQualifications','equipment','licenses','skills']
for i in range(1,6): K += [f'w{i}Employer',f'w{i}Location',f'w{i}Title',f'w{i}Nature',f'w{i}Salary',f'w{i}From',f'w{i}To']
K += ['signName']
assert len(K) == 110, len(K)
ki = iter(K)
def para(m):
    p = m.group(0)
    if '_' not in ''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', p)): return p
    def run(r):
        rm = re.match(r'(<w:r(?: [^>]*)?>)(<w:rPr>.*?</w:rPr>)?(.*)</w:r>$', r.group(0), re.S)
        rpr = rm.group(2) or ''
        out = ''
        # keep tabs and other run content in order; split only the text into label and blank runs
        for part in re.split(r'(<w:t(?: [^>]*)?>[^<]*</w:t>)', rm.group(3)):
            if not part: continue
            t = re.match(r'<w:t(?: [^>]*)?>([^<]*)</w:t>$', part)
            if not t: out += f'<w:r>{rpr}{part}</w:r>'; continue
            for seg in re.split(r'(_+)', t.group(1)):
                if not seg: continue
                if seg[0] == '_': out += f'<w:r>{rpr}<w:t xml:space="preserve">{{{{{next(ki)}|{len(seg)}}}}}</w:t></w:r>'
                else: out += f'<w:r>{rpr}<w:t xml:space="preserve">{seg}</w:t></w:r>'
        return out
    return re.sub(r'<w:r(?: [^>]*)?>.*?</w:r>', run, p, flags=re.S)
# a blank split across two runs is joined into the first run, so it stays one blank
def join_split(p):
    rs = list(re.finditer(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', p))
    for u, v in zip(rs, rs[1:]):
        if u.group(1).endswith('_') and v.group(1).startswith('_'):
            n = len(v.group(1)) - len(v.group(1).lstrip('_'))
            p = p[:u.start(1)] + u.group(1) + '_' * n + p[u.end(1):v.start(1)] + v.group(1)[n:] + p[v.end(1):]
            return join_split(p)
    return p
x = re.sub(r'<w:p[ >](?:(?!<w:p[ >]).)*?</w:p>', lambda m: join_split(m.group(0)), x, flags=re.S)
x = re.sub(r'<w:p[ >](?:(?!<w:p[ >]).)*?</w:p>', para, x, flags=re.S)
assert next(ki, None) is None, 'not all keys used'
CELL = '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r>'
def fill_table(tbl, rowkeys):
    rows = re.findall(r'<w:tr[ >].*?</w:tr>', tbl, re.S)
    for r, keys in zip(rows[1:], rowkeys):
        cells = re.findall(r'<w:tc>.*?</w:tc>', r, re.S); nr = r
        for c, k in zip(cells, keys):
            sep = ' ' if '<w:t' in c else ''
            nc = re.sub(r'</w:p>', CELL.format(sep + '{{' + k + '|0}}') + '</w:p>', c, count=1)
            nr = nr.replace(c, nc, 1)
        tbl = tbl.replace(r, nr, 1)
    return tbl
tbls = re.findall(r'<w:tbl>.*?</w:tbl>', x, re.S)
assert len(tbls) == 2
fam = [['faName','faAge','faBirth','faOccupation','faAddress'], ['moName','moAge','moBirth','moOccupation','moAddress']] + \
      [[f's{i}Name',f's{i}Age',f's{i}Birth',f's{i}Occupation',f's{i}Address'] for i in range(1,9)]
ref = [[f'r{i}Name',f'r{i}Occupation',f'r{i}Address',f'r{i}Phone'] for i in range(1,4)]
assert len(re.findall(r'<w:tr[ >]', tbls[0])) == 11 and len(re.findall(r'<w:tr[ >]', tbls[1])) == 4
x = x.replace(tbls[0], fill_table(tbls[0], fam), 1).replace(tbls[1], fill_table(tbls[1], ref), 1)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as o:
    for it in z.infolist():
        o.writestr(it, x.encode('utf-8') if it.filename == 'word/document.xml' else z.read(it.filename))
print('placeholders:', len(re.findall(r'\{\{', x)))
