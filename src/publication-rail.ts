export interface RailTerm { target: string; title: string; label: string; }
export interface RailNote { target: string; number: number; body: string; }

const maximumDeclarations = 1000;
const maximumContent = 2 * 1024 * 1024;
function identifier(value: string): void {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,8191}$/.test(value)) {
        throw new Error('Rail targets and labels must be safe ASCII identifiers (1–8192 characters)');
    }
}
function controlledText(value: string): void {
    if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
        value.length > 131072) { throw new Error('Invalid or oversized controlled rail LaTeX'); }
}
function suffix(index: number): string {
    let result = '';
    do {
        result = String.fromCharCode(65 + index % 26) + result;
        index = Math.floor(index / 26) - 1;
    } while (index >= 0);
    return result;
}
function luaLoader(source: string): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < source.length; offset += 128) {
        chunks.push('string.char(' + Array.from(source.slice(offset, offset + 128),
            character => character.charCodeAt(0)).join(',') + ')');
    }
    return '\\directlua{assert(load(table.concat({' + chunks.join(',\n') + '}),"literate-rail"))()}';
}

/** The caller supplies controlled LaTeX, loads hyperref, and reserves the outer rail. */
export function publicationRail(terms: readonly RailTerm[], notes: readonly RailNote[], fontSize = 9): string {
    if (!Number.isFinite(fontSize) || fontSize < 7 || fontSize > 14) {
        throw new Error('Rail font size must be 7–14 points');
    }
    if (terms.length > maximumDeclarations || notes.length > maximumDeclarations) {
        throw new Error('Rail supports at most 1000 terms and 1000 notes');
    }
    const targets = new Set<string>(), labels = new Set<string>(), numbers = new Set<number>();
    let size = 0;
    for (const item of [...terms, ...notes]) {
        identifier(item.target);
        if (targets.has(item.target)) { throw new Error(`Duplicate rail target: ${item.target}`); }
        targets.add(item.target); size += item.target.length;
    }
    for (const term of terms) {
        identifier(term.label); controlledText(term.title);
        if (labels.has(term.label)) { throw new Error(`Duplicate rail definition label: ${term.label}`); }
        labels.add(term.label); size += term.label.length + term.title.length;
    }
    for (const note of notes) {
        controlledText(note.body);
        if (!Number.isSafeInteger(note.number) || note.number < 1 || note.number > 10000 || numbers.has(note.number)) {
            throw new Error('Rail note numbers must be unique integers in 1–10000');
        }
        numbers.add(note.number); size += note.body.length;
    }
    if (size > maximumContent) { throw new Error('Rail declarations exceed 2 MiB'); }
    if (!terms.length && !notes.length) { return ''; }
    const declarations = [
        ...terms.map(term => ({ target: term.target, kind: 'term', number: 0, label: term.label,
            body: `\\hyperref[${term.label}]{\\textbf{${term.title}}\\space\\pageref*{${term.label}}}` })),
        ...notes.map(note => ({ ...note, kind: 'note', label: '',
            body: `\\textbf{${note.number}.}\\space ${note.body}` }))
    ];
    const registration = declarations.map((item, index) =>
        `litrail.declare(${index + 1},"${item.target}","${item.kind}",${item.number})`).join('\n');
    const boxes = declarations.map((item, index) => {
        const name = suffix(index);
        return `\\expandafter\\newbox\\csname LitRailBox${name}\\endcsname\n` +
            `\\long\\def\\LitRailBody${name}{${item.body}}\n` +
            `\\AddToHook{begindocument/end}{\\LitRailBuild{${index + 1}}{${name}}{${item.label}}}`;
    }).join('\n');
    return luaLoader(railLua() + '\n' + registration) + '\n' + railTex(fontSize) + '\n' + boxes + '\n';
}

function railTex(fontSize: number): string {
    const size = String(Number(fontSize.toFixed(2)));
    const leading = String(Number((fontSize * 1.2).toFixed(2)));
    return String.raw`\makeatletter
\newif\ifLitRailBuilding
\newcommand{\LitRailPrevious}[5]{\directlua{litrail.previous(#1,#2,#3,#4,#5)}}
\newcommand{\LitRailState}[1]{\directlua{litrail.oldhash="\luaescapestring{#1}"}}
\newcommand{\LitRailWrite}[5]{\immediate\write\@auxout{\string\LitRailPrevious{#1}{#2}{#3}{#4}{#5}}}
\newcommand{\LitRailWriteState}[1]{\immediate\write\@auxout{\string\LitRailState{#1}}}
\newcommand{\LitRailBuild}[3]{%
  \begingroup\LitRailBuildingtrue
  \hsize=\marginparwidth\linewidth=\hsize\columnwidth=\hsize\textwidth=\hsize
  \@totalleftmargin=0pt\leftmargini=14pt\leftmarginii=12pt\labelsep=3pt
  \notefont\fontsize{${size}pt}{${leading}pt}\selectfont
  \ifdefined\microtypesetup\microtypesetup{protrusion=false,expansion=false}\fi
  \parindent=0pt\parskip=2pt\raggedright
  \expandafter\global\expandafter\setbox\csname LitRailBox#2\endcsname=\vbox{%
    \kern2mm\csname LitRailBody#2\endcsname\par\kern2mm}%
  \def\LitRailResolved{1}\def\LitRailPage{}%
  \if\relax\detokenize{#3}\relax\else
    \ifcsname r@#3\endcsname\edef\LitRailPage{\getpagerefnumber{#3}}%
    \else\def\LitRailResolved{0}\fi
  \fi
  \directlua{litrail.box(#1,\expandafter\number\csname LitRailBox#2\endcsname,
    "LitRailBody#2",\LitRailResolved,"\luaescapestring{\LitRailPage}")}%
  \endgroup}
\DeclareRobustCommand{\LitTermUse}[3]{%
  \ifLitRailBuilding\directlua{litrail.reject("nested rail marker")}%
  \else\leavevmode\directlua{litrail.use("\luaescapestring{#1}","\luaescapestring{#2}","term")}#3\fi}
\DeclareRobustCommand{\LitNoteUse}[1]{%
  \ifLitRailBuilding\directlua{litrail.reject("nested rail marker")}%
  \else\leavevmode\directlua{litrail.use("\luaescapestring{#1}","\luaescapestring{#1}","note")}\fi}
\AddToHook{begindocument/end}{%
  \if@twocolumn\directlua{litrail.reject("two-column rail unsupported")}\fi}
\AddToHook{shipout/foreground}{%
  \setlength${'\\unitlength'}{1pt}%
  \directlua{litrail.ship(
    \number\ReadonlyShipoutCounter,\if@twoside 1\else 0\fi,
    \number\dimexpr1in+\hoffset+\oddsidemargin\relax,
    \number\dimexpr1in+\hoffset+\evensidemargin\relax,
    \number\dimexpr1in+\voffset+\topmargin+\headheight+\headsep\relax,
    \number\textwidth,\number\textheight,\number\marginparwidth,\number\marginparsep)}}
\AddToHook{enddocument/afterlastpage}{\directlua{litrail.finish()}}
\makeatother`;
}

function railLua(): string {
    return String.raw`litrail = { defs={}, targets={}, old={}, oldpages={}, current={}, issued={}, seen={}, pages={},
  oldhash="", page=0, count=0, nodes=0, bounds={}, problems={}, fingerprints={} }
local R = litrail
local mm = 65536*72.27/25.4
local gap = tex.sp("2mm")
local function fatal(message)
  R.failed=true
  local f = assert(io.open(tex.jobname..".litrail", "w"))
  f:write("error\n",message,"\n"); f:close()
  tex.error("Literate rail: "..message, {"No shrinking, splitting, overlap, or page spill is permitted."})
end
R.reject=fatal
local function pending(message) R.problems[#R.problems+1]=message end
local function digest(text) return md5.sumhexa(text) end
local function validid(id)
  return #id>0 and #id<=8192 and id:match("^[%w][%w:._%-]*$")
end
local start = assert(io.open(tex.jobname..".litrail", "w"))
start:write("pending\n"); start:close()
function R.declare(index,target,kind,number)
  R.defs[index]={target=target,kind=kind,number=number}
  R.targets[target]=index
end
function R.previous(use,definition,page,x,y)
  if R.finished then return end
  if #R.old>=10000 or use<1 or use>10000 or definition<1 or definition>2000 or
     page<1 or page>100000 then fatal("invalid or excessive auxiliary records"); return end
  local record={use,definition,page,x,y}
  R.old[#R.old+1]=record
  R.oldpages[page]=R.oldpages[page] or {}
  table.insert(R.oldpages[page],record)
end
local function audit(box)
  local trace, fonts, failure = {}, {}, nil
  local function visit(parent,x,depth)
    if depth>64 then fatal("rail box nesting exceeds 64"); return end
    local horizontal=parent.id==node.id("hlist")
    local cursor=x
    for n in node.traverse(parent.list) do
      R.nodes=R.nodes+1
      if R.nodes>500000 then fatal("rail box node budget exceeds 500000"); return end
      local kind=node.type(n.id)
      trace[#trace+1]=table.concat({kind,n.subtype or 0,n.width or 0,n.height or 0,
        n.depth or 0,n.shift or 0,n.kern or 0,n.glue_set or 0,n.glue_sign or 0,n.glue_order or 0},":")
      local at=horizontal and cursor or x+(n.shift or 0)
      if kind=="glyph" then
        trace[#trace+1]=table.concat({n.char,n.font,n.xoffset,n.yoffset},":")
        if not fonts[n.font] then
          local fontdata=font.getfont(n.font)
          trace[#trace+1]=table.concat({fontdata.name or "",fontdata.filename or "",fontdata.size or 0},":")
          fonts[n.font]=true
        end
        local left=at+n.xoffset
        if left < -1 or left+n.width > box.width+1 then
          failure=string.format("horizontal protrusion (glyph U+%04X at %.3f..%.3f mm; width %.3f mm)",
            n.char,left/mm,(left+n.width)/mm,box.width/mm)
        end
      elseif kind=="hlist" or kind=="vlist" then
        visit(n,at,depth+1)
      elseif kind=="rule" and n.width>0 then
        if at < -1 or at+n.width > box.width+1 then failure="horizontal rule protrusion" end
      elseif kind=="dir" and n.dir~="TLT" and n.dir~="+TLT" and n.dir~="-TLT" then
        failure="unsupported rail text direction"
      end
      if horizontal then
        local width=0
        if kind=="glyph" or kind=="hlist" or kind=="vlist" or kind=="rule" or kind=="glue" then width=n.width end
        if kind=="glue" then
          if parent.glue_sign==1 and n.stretch_order==parent.glue_order then width=width+parent.glue_set*n.stretch end
          if parent.glue_sign==2 and n.shrink_order==parent.glue_order then width=width-parent.glue_set*n.shrink end
        elseif kind=="kern" then width=n.kern
        elseif kind=="disc" then
          -- A surviving discretionary contributes its replacement list.
          local replacement=n.replace
          if replacement then
            local wrapper=node.new("hlist"); wrapper.list=node.copy_list(replacement)
            visit(wrapper,cursor,depth+1)
            width=node.dimensions(replacement); node.flush_node(wrapper)
          end
        end
        cursor=cursor+width
      end
    end
  end
  visit(box,0,0)
  return digest(table.concat(trace,"|")),failure
end
function R.box(index,number,macro,resolved,page)
  local d=R.defs[index]
  local b=tex.box[number]
  local shape,problem=audit(b)
  d.box=number; d.height=b.height+b.depth; d.width=b.width; d.resolved=resolved==1
  d.problem=problem
  d.fingerprint=digest(table.concat({d.target,d.kind,d.number,token.get_macro(macro),
    b.width,b.height,b.depth,page,resolved,shape},"|"))
end
function R.use(id,target,kind)
  local index=R.targets[target]
  if not validid(id) or not index or R.defs[index].kind~=kind then fatal("invalid annotation marker"); return end
  local identity=kind..":"..id
  if R.seen[identity] then fatal("duplicate occurrence "..id.." (moving arguments must be marker-free)"); return end
  if R.count>=10000 then fatal("annotation use budget exceeds 10000"); return end
  R.seen[identity]=true; R.count=R.count+1
  R.issued[R.count]={index=index,id=id,kind=kind}
  tex.sprint("\\latelua{litrail.mark("..R.count..")}")
  if kind=="note" then
    tex.sprint("\\hyperlink{lit-rail-note-"..index.."}{\\textsuperscript{\\notefont "..R.defs[index].number.."}}")
  end
end
function R.mark(use)
  local entry=R.issued[use]
  if not entry or entry.shipped then fatal("missing or replayed annotation marker"); return end
  entry.shipped=true
  local x,y=pdf.getpos()
  R.current[#R.current+1]={use,entry.index,R.page,math.floor(x),math.floor(tex.pageheight-y)}
end
local function itemsFor(page)
  local records=R.oldpages[page] or {}
  table.sort(records,function(a,b)
    if a[5]~=b[5] then return a[5]<b[5] end
    if a[4]~=b[4] then return a[4]<b[4] end
    return a[1]<b[1]
  end)
  local items,seen={},{}
  for _,r in ipairs(records) do
    local d=R.defs[r[2]]
    if d and d.box then
      if d.kind=="note" and seen[r[2]] then pending("replayed note "..d.target) end
      if not seen[r[2]] then
        seen[r[2]]=true
        items[#items+1]={index=r[2],d=d,desired=r[5]-tex.sp("3mm")}
      end
    else pending("stale annotation declaration") end
  end
  return items
end
function R.ship(page,twoside,oddleft,evenleft,top,body,height,width,separation)
  if R.failed then return end
  if page~=R.page+1 then fatal("nonsequential physical shipout"); return end
  if page>100000 then fatal("page budget exceeds 100000"); return end
  if twoside~=0 and twoside~=1 then fatal("invalid page-side mode"); return end
  R.page=page
  local oddx=oddleft+body+separation
  local evenx=evenleft-separation-width
  local left=twoside==1 and page%2==0
  local bodyx=left and evenleft or oddleft
  local x=left and evenx or oddx
  local function valid(candidateBody,candidateRail)
    return candidateBody>=0 and candidateBody+body<=tex.pagewidth and candidateRail>=0
      and candidateRail+width<=tex.pagewidth
  end
  if math.abs(width-tex.sp("25mm"))>1 or math.abs(separation-tex.sp("5mm"))>1 or
     body<tex.sp("80mm") or height<tex.sp("100mm") or top<0 or top+height>tex.pageheight or
     not valid(oddleft,oddx) or (twoside==1 and not valid(evenleft,evenx)) then
    fatal("invalid geometry: require 25 mm outer rail, 5 mm gap, 80 x 100 mm body inside the page"); return
  end
  R.pages[#R.pages+1]=table.concat({R.page,twoside,bodyx,x,top,body,height,width,separation,
    tex.pagewidth,tex.pageheight},",")
  local items=itemsFor(R.page)
  local needed=math.max(0,#items-1)*gap
  local failed=false
  for _,item in ipairs(items) do
    local d=item.d
    needed=needed+d.height
    if d.problem or not d.resolved or d.width~=width then
      pending("page "..R.page..", "..d.target..": "..(d.problem or (not d.resolved and "unresolved definition page" or "rail width changed")))
      failed=true
    end
  end
  if needed>height then
    pending(string.format("overflow on absolute page %d: required %.3f mm, available %.3f mm",R.page,needed/mm,height/mm))
    failed=true
  end
  if failed then return end
  local cursor=top
  for _,item in ipairs(items) do item.y=math.max(cursor,item.desired); cursor=item.y+item.d.height+gap end
  cursor=top+height
  for i=#items,1,-1 do local item=items[i]; item.y=math.min(item.y,cursor-item.d.height); cursor=item.y-gap end
  cursor=top-gap
  for _,item in ipairs(items) do
    if item.y<cursor+gap or item.y+item.d.height>top+height then fatal("internal placement bounds violation"); return end
    cursor=item.y+item.d.height
    R.bounds[#R.bounds+1]=table.concat({R.page,item.index,x,item.y,width,item.d.height},",")
    local destination=item.d.kind=="note" and ("lit-rail-note-"..item.index) or ("lit-rail-term-"..R.page.."-"..item.index)
    tex.sprint(string.format("\\put(%.8f,%.8f){\\vtop{\\kern0pt\\hbox{\\hypertarget{%s}{\\copy%d}}}}",x/65536,-item.y/65536,destination,item.d.box))
  end
end
function R.finish()
  R.finished=true
  if R.failed then return end
  for _,entry in ipairs(R.issued) do
    if not entry.shipped then fatal("unshipped annotation occurrence "..entry.id); return end
    R.fingerprints[#R.fingerprints+1]=entry.kind..":"..entry.id..":"..entry.index
  end
  for _,d in ipairs(R.defs) do
    if d.kind=="note" and not R.seen["note:"..d.target] then fatal("note has no source marker: "..d.target); return end
    R.fingerprints[#R.fingerprints+1]=d.fingerprint or "unbuilt"
  end
  local records={}
  for _,r in ipairs(R.current) do
    records[#records+1]=table.concat(r,",")
    tex.sprint(string.format("\\LitRailWrite{%d}{%d}{%d}{%d}{%d}",table.unpack(r)))
  end
  local hash=digest(table.concat(R.fingerprints,"|")..";"..table.concat(records,"|")..";"..
    table.concat(R.pages,"|")..";"..table.concat(R.bounds,"|")..";"..table.concat(R.problems,"|"))
  tex.sprint("\\LitRailWriteState{"..hash.."}")
  if hash==R.oldhash and #R.problems>0 then fatal(R.problems[1]); return end
  local stable=hash==R.oldhash
  local f=assert(io.open(tex.jobname..".litrail","w"))
  f:write(stable and "stable " or "pending ",hash,"\n")
  f:write(string.format("pages %d uses %d entries %d\n",R.page,#R.current,#R.bounds))
  for _,b in ipairs(R.bounds) do f:write("bounds ",b,"\n") end
  f:close()
  if not stable then tex.sprint("\\PackageWarningNoLine{literate-rail}{Rerun to get rail membership, dimensions and references right}") end
end`;
}
