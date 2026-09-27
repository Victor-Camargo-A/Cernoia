"""Stream a spreadsheet to JSONL. Shared strings live in SQLite, never a RAM list."""
import csv,json,sys,zipfile,sqlite3,os,re,unicodedata,posixpath,resource
import xml.etree.ElementTree as ET
from functools import lru_cache

resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(900,900))
MAX_ROWS=1100000
def emit(value):print(json.dumps(value,ensure_ascii=False),flush=True)
def norm(value):return re.sub('[^a-z0-9]','',unicodedata.normalize('NFKD',str(value)).encode('ascii','ignore').decode().lower())
def local(tag):return tag.rsplit('}',1)[-1]
def elements(stream,wanted):
 stack=[]
 for event,element in ET.iterparse(stream,events=('start','end')):
  if event=='start':
   stack.append(element)
   if len(stack)>100:raise ValueError('El Excel contiene una estructura demasiado profunda.')
  else:
   if local(element.tag)==wanted:
    yield element
    if len(stack)>1:stack[-2].remove(element)
    element.clear()
   stack.pop()
def header_indices(row):
 headers=[norm(value) for value in row]
 email=next((i for i,h in enumerate(headers) if h in ('email','correo','correoelectronico','emailaddress')),None)
 if email is None:email=next((i for i,h in enumerate(headers) if 'correo' in h or 'email' in h),None)
 if email is None:raise ValueError('No se encontró una columna de correo electrónico en la primera hoja.')
 company=next((i for i,h in enumerate(headers) if h in ('empresa','razonsocial','company','companyname') or ('nombre' in h and ('entidad' in h or 'proveedor' in h))),None)
 contact=next((i for i,h in enumerate(headers) if h in ('contacto','nombre','contactname','nombrecontacto','nombredelcontacto')),None)
 provider=next((i for i,h in enumerate(headers) if h=='esproveedor'),None)
 if provider is None:raise ValueError('Falta la columna Es proveedor. Vuelve a cargar el Excel original con esa columna.')
 return email,company,contact,provider
def records(rows):
 indices=None;count=0
 for row in rows:
  if not any(str(x).strip() for x in row):continue
  if indices is None:indices=header_indices(row);emit({'phase':'Leyendo contactos'});continue
  count+=1
  if count>MAX_ROWS:raise ValueError('La hoja supera 1.100.000 filas; divide la lista en varios archivos.')
  def at(index,limit):return str(row[index] if index is not None and index<len(row) else '').strip()[:limit]
  if unicodedata.normalize('NFKD',at(indices[3],100)).encode('ascii','ignore').decode().lower()!='si':
   emit({'excluded':True});continue
  emit({'email':at(indices[0],1000),'company_name':at(indices[1],300),'contact_name':at(indices[2],180)})
 if indices is None:raise ValueError('El archivo no contiene encabezados ni contactos.')
def xlsx_rows(path):
 cache=path+'.strings.sqlite';db=sqlite3.connect(cache)
 try:
  db.execute('PRAGMA journal_mode=OFF');db.execute('PRAGMA cache_size=-4096');db.execute('CREATE TABLE IF NOT EXISTS strings(id INTEGER PRIMARY KEY,value TEXT)');db.execute('DELETE FROM strings')
  with zipfile.ZipFile(path) as z:
   if sum(info.file_size for info in z.infolist())>4*1024**3:raise ValueError('El contenido del Excel supera 4 GB. Exporta solamente las columnas de contactos a CSV.')
   def xml(name):
    if z.getinfo(name).file_size>2*1024**2:raise ValueError('Los metadatos del Excel son demasiado grandes.')
    return ET.fromstring(z.read(name))
   workbook=xml('xl/workbook.xml');sheet=next((e for e in workbook.iter() if local(e.tag)=='sheet'),None)
   if sheet is None:raise ValueError('El Excel no contiene hojas.')
   rid=next((v for k,v in sheet.attrib.items() if local(k)=='id'),None)
   relation=next((e for e in xml('xl/_rels/workbook.xml.rels') if e.get('Id')==rid),None)
   if relation is None or relation.get('TargetMode')=='External':raise ValueError('La primera hoja no está disponible.')
   target=relation.get('Target','');target=posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/'+target)
   if not target.startswith('xl/worksheets/'):raise ValueError('La ruta de la primera hoja no es válida.')
   if 'xl/sharedStrings.xml' in z.namelist():
    emit({'phase':'Preparando textos del Excel'})
    with z.open('xl/sharedStrings.xml') as stream:
     for i,element in enumerate(elements(stream,'si')):
      value=''.join(e.text or '' for e in element.iter() if local(e.tag)=='t')
      if len(value)>10000:raise ValueError('El Excel contiene una celda de texto demasiado larga.')
      db.execute('INSERT INTO strings VALUES(?,?)',(i,value))
      if i%10000==0:db.commit();emit({'phase':'Preparando textos del Excel','strings':i})
    db.commit()
   @lru_cache(maxsize=4096)
   def shared(index):
    value=db.execute('SELECT value FROM strings WHERE id=?',(index,)).fetchone()
    return value[0] if value else ''
   with z.open(target) as stream:
    for element in elements(stream,'row'):
     cells={}
     for c in element:
      if local(c.tag)!='c':continue
      ref=re.match(r'([A-Z]+)',c.get('r',''))
      if not ref:continue
      column=0
      for char in ref.group(1):column=column*26+ord(char)-64
      column-=1
      if column>=500:continue
      # A formula is never evaluated or used as a contact value.
      if any(local(e.tag)=='f' for e in c):continue
      value=next((e.text or '' for e in c if local(e.tag)=='v'),'')
      if c.get('t')=='s':value=shared(int(value)) if value else ''
      elif c.get('t')=='inlineStr':value=''.join(e.text or '' for e in c.iter() if local(e.tag)=='t')
      cells[column]=value[:10000]
     if cells:yield [cells.get(i,'') for i in range(max(cells)+1)]
 finally:
  db.close()
  try:os.unlink(cache)
  except FileNotFoundError:pass
def main():
 path=sys.argv[1]
 if path.lower().endswith('.xlsx'):records(xlsx_rows(path))
 else:
  csv.field_size_limit(100000)
  with open(path,encoding='utf-8-sig',newline='') as stream:
   sample=stream.read(8192);stream.seek(0)
   try:delimiter=csv.Sniffer().sniff(sample,delimiters=',;\t').delimiter
   except csv.Error:delimiter=';' if sample.splitlines()[0].count(';')>sample.splitlines()[0].count(',') else ','
   records(csv.reader(stream,delimiter=delimiter))
try:main()
except Exception as error:
 emit({'error':str(error)[:500] or 'No se pudo leer el archivo.'});sys.exit(1)
