import io,sys
for p in sys.argv[1:]:
    b=open(p,'rb').read()
    if b.startswith(b'\xef\xbb\xbf'): b=b[3:]
    open(p,'wb').write(b'\xef\xbb\xbf'+b)
    print('BOM ok', p)