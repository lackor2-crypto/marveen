import subprocess, sys
def hunks(path):
    d = subprocess.run(['git','diff','-U3','--',path], capture_output=True, text=True, cwd='{{PROJECT_ROOT}}').stdout
    lines = d.split('\n')
    first = next(i for i,l in enumerate(lines) if l.startswith('@@'))
    header = lines[:first]
    hs, cur = [], None
    for l in lines[first:]:
        if l.startswith('@@'):
            if cur: hs.append(cur)
            cur = [l]
        elif cur is not None:
            cur.append(l)
    if cur: hs.append(cur)
    return header, hs
def build(sel):
    out = []
    for path, idxs in sel:
        header, hs = hunks(path)
        out += header
        for i in idxs: out += hs[i]
    return '\n'.join(out).rstrip('\n') + '\n'
if __name__ == '__main__':
    sel = eval(sys.argv[1])
    open(sys.argv[2],'w').write(build(sel))
    for path, idxs in sel:
        _, hs = hunks(path)
        for i in idxs: print(f'  {path}: {hs[i][0][:70]}')
