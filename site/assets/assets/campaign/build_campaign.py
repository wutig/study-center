"""Build the fixed offline study map from historical settlement coordinates.

Run with Python 3 and Shapely 2.1+ (the project's optional build dependency is
kept in .runtime/geometry-deps). Browser use has no GIS or network dependency.
The Voronoi cells are original study illustrations, never historic boundaries.
"""
from pathlib import Path
import hashlib
import json
import math
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APP_ROOT = ROOT.parent
sys.path.insert(0, str(APP_ROOT / '.runtime' / 'geometry-deps'))

from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon, MultiPolygon, GeometryCollection, Point, box, shape
from shapely.affinity import affine_transform
from shapely.ops import unary_union

MINX, MINY, MAXX, MAXY = 105, 23, 122, 41
# A fixed design resolution. This value is deliberately unrelated to question
# counts. Only reviewed/available changes the area filled in the browser.
MAP_CELL_COUNT = 203
PRECISION = 6
TOLERANCE = 0.02  # square SVG units, < 1e-7 of the visible lost-land area


def ring_area(ring):
    return abs(sum(a[0]*b[1]-a[1]*b[0]
                   for a, b in zip(ring, ring[1:]+ring[:1]))) / 2


def clip_halfplane(poly, a, b, c):
    """Clip a convex polygon to ax + by <= c."""
    if not poly:
        return []
    result = []
    prev = poly[-1]
    pv = a*prev[0]+b*prev[1]-c
    for curr in poly:
        cv = a*curr[0]+b*curr[1]-c
        if (cv <= 1e-8) != (pv <= 1e-8):
            fraction = pv/(pv-cv)
            result.append([prev[0]+fraction*(curr[0]-prev[0]),
                           prev[1]+fraction*(curr[1]-prev[1])])
        if cv <= 1e-8:
            result.append(curr)
        prev, pv = curr, cv
    return result


def project(lon, lat, z=None):
    return 80+(lon-MINX)*46.6, 35+(MAXY-lat)*38.33


def projected_ring(ring):
    return [[round(v, PRECISION) for v in project(*p[:2])] for p in ring]


def polygons(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry] if geometry.area > 1e-9 else []
    if isinstance(geometry, (MultiPolygon, GeometryCollection)):
        return [p for part in geometry.geoms for p in polygons(part)]
    return []


def rounded_geometry(geometry):
    """Quantize the actual rendered coordinates before triangulation."""
    parts = []
    for p in polygons(geometry):
        exterior = [[round(x, PRECISION), round(y, PRECISION)]
                    for x, y in p.exterior.coords]
        holes = [[[round(x, PRECISION), round(y, PRECISION)]
                  for x, y in r.coords] for r in p.interiors]
        candidate = Polygon(exterior, holes)
        if not candidate.is_valid:
            candidate = candidate.buffer(0)
        parts.extend(polygons(candidate))
    return unary_union(parts)


def svg_number(value):
    return f'{value:.6f}'.rstrip('0').rstrip('.')


def svg_ring(ring):
    coords = list(ring.coords) if hasattr(ring, 'coords') else ring
    return 'M'+'L'.join(','.join(svg_number(v) for v in p[:2])
                       for p in coords)+'Z'


def svg_path(geometry):
    # Polygon boundaries, not triangle edges: the browser can stroke each
    # historic-place cell without showing internal triangulation seams.
    return ''.join(svg_ring(p.exterior)+''.join(svg_ring(r) for r in p.interiors)
                   for p in polygons(geometry))


def triangulated_pieces(geometry):
    result = []
    for poly in polygons(geometry):
        triangles = constrained_delaunay_triangles(poly)
        for tri in triangles.geoms:
            ring = [[round(x, PRECISION), round(y, PRECISION)]
                    for x, y in list(tri.exterior.coords)[:-1]]
            if ring_area(ring) > 1e-9:
                result.append(ring)
    return result


def distance_squared(a, b):
    # Equirectangular approximation at 35 N: distances are geographic rather
    # than dependent on the intentionally fitted SVG display aspect ratio.
    return ((a['lon']-b['lon'])*math.cos(math.radians(35)))**2 + (a['lat']-b['lat'])**2


source_file = HERE/'ne_50m_land.source.geojson'
source = json.loads(source_file.read_text(encoding='utf-8'))
theatre = box(MINX, MINY, MAXX, MAXY)
land_parts = []
for feature in source['features']:
    geom = shape(feature['geometry'])
    if geom.intersects(theatre):
        land_parts.extend(polygons(geom.intersection(theatre)))
# Offshore islands are excluded: they must not be presented as Jin-held land.
land_geo = max(land_parts, key=lambda p:p.area)
base_geo = Polygon([[105,23],[122,23],[122,31.5],[121,31.7],[119,31.6],
                    [117.5,31.0],[116,30.6],[114.5,30.9],[113,31.1],
                    [111,31.0],[109,31.3],[107,31.0],[105,31.2]])
projection_matrix = [46.6, 0, 0, -38.33, 80-MINX*46.6, 35+MAXY*38.33]
land = rounded_geometry(affine_transform(land_geo, projection_matrix))
base = rounded_geometry(affine_transform(base_geo, projection_matrix).intersection(land))
lost = rounded_geometry(land.difference(base))

gazetteer = json.loads((HERE/'historical-places.json').read_text(encoding='utf-8'))
candidates = []
for p in gazetteer['places']:
    x, y = project(p['lon'], p['lat'])
    if lost.contains(Point(x, y)):
        candidates.append(dict(p, x=round(x, PRECISION), y=round(y, PRECISION)))
assert len(candidates) >= MAP_CELL_COUNT

# Start with the documented major prefectural settlements, then fill the
# remaining space by farthest-point sampling. No random or invented seed is
# ever inserted, and adding a course does not regenerate this map.
selected = sorted([p for p in candidates if p['feature_type']=='府'], key=lambda p:p['id'])
assert len(selected) < MAP_CELL_COUNT
if not selected:
    selected = [min(candidates, key=lambda p:(p['lat'],p['lon'],p['id']))]
remaining = {p['id']:p for p in candidates if p['id'] not in {s['id'] for s in selected}}
distances = {key:min(distance_squared(p,s) for s in selected) for key,p in remaining.items()}
while len(selected) < MAP_CELL_COUNT:
    key = max(remaining, key=lambda key:(distances[key],-remaining[key]['priority'],key))
    chosen = remaining.pop(key)
    distances.pop(key)
    selected.append(chosen)
    for key, p in remaining.items():
        distances[key] = min(distances[key], distance_squared(p, chosen))
selected.sort(key=lambda p:(p['lat'],p['lon'],p['id']))

cells = []
cell_geometries = []
for ordinal, p in enumerate(selected, 1):
    sx, sy = p['x'], p['y']
    boundary = [[0,0],[960,0],[960,760],[0,760]]
    for q in selected:
        if q['id'] != p['id']:
            tx, ty = q['x'], q['y']
            boundary = clip_halfplane(boundary,2*(tx-sx),2*(ty-sy),
                                      tx*tx+ty*ty-sx*sx-sy*sy)
    visible = rounded_geometry(Polygon(boundary).intersection(lost))
    assert not visible.is_empty and visible.area > 0
    pieces = triangulated_pieces(visible)
    visible_area = sum(ring_area(piece) for piece in pieces)
    assert abs(visible_area-visible.area) < TOLERANCE
    assert abs(unary_union([Polygon(piece) for piece in pieces]).area-visible.area) < TOLERANCE
    cell = {key:p[key] for key in ['name','lon','lat','priority','feature_type',
                                   'source_url','source_id','source_line','record_url',
                                   'source_note','period','valid_from','valid_to','modernName']}
    cell.update(id=p['id'],ordinal=ordinal,x=sx,y=sy,labelX=sx,labelY=sy,
                path=svg_path(visible),fillRule='evenodd',area=round(visible_area,8),
                pieces=pieces,
                bounds=[round(v,PRECISION) for v in visible.bounds])
    cells.append(cell)
    cell_geometries.append(visible)

total_lost_area = sum(c['area'] for c in cells)
merged = unary_union(cell_geometries)
union_error = merged.symmetric_difference(lost).area
overlap_error = sum(p.area for p in cell_geometries)-merged.area
assert len(cells)==MAP_CELL_COUNT==len({c['id'] for c in cells})==len({c['name'] for c in cells})
assert abs(total_lost_area-lost.area) < TOLERANCE
assert union_error < TOLERANCE and abs(overlap_error) < TOLERANCE
assert [c['lat'] for c in cells] == sorted(c['lat'] for c in cells)

milestones = json.loads((HERE/'rewards-v2.json').read_text(encoding='utf-8'))
assert len(milestones)>=27 and all(0<m['threshold']<=1 for m in milestones)
assert [m['threshold'] for m in milestones] == sorted(m['threshold'] for m in milestones)

rivers_info = [
 ('长江',[[105,28.9],[106.5,29.6],[107.7,30.2],[109.4,31.0],[111.2,30.7],[112.3,30.1],[113.8,30.6],[114.4,30.5],[115.8,29.7],[116.9,30.1],[117.8,30.7],[118.8,31.4],[119.8,32.1],[121.6,31.5]]),
 ('黄河',[[105,36.8],[106.2,37.7],[107.1,39],[108.6,40.5],[110.7,40.3],[111.2,39.1],[110.8,37],[110.3,35.5],[110.4,34.7],[112.2,34.8],[114.3,35.1],[116.2,35.9],[117.3,37.2],[119,37.8]]),
 ('淮河',[[113.3,32.5],[114.6,32.4],[115.5,32.5],[116.3,32.6],[117.3,32.9],[118.6,33.2],[119.3,33.4]])]
rivers = []
for name, points in rivers_info:
    path = 'M'+'L'.join(','.join(svg_number(v) for v in project(*p)) for p in points)
    rivers.append(dict(name=name,path=path,kind='schematic-natural-river',
                       note='仅作自然地理参照；现代线形简化，不代表宋代河道'))

sources = [
    {'id':'original-index','title':'阅文小说网《绍宋》原著简介及目录',
     'url':'https://www.xs.cn/book/15610037104915904','role':'原著章节存在与主线核对'},
    {'id':'author-interview','title':'中国作家网：榴弹怕水谈八公山与历史虚构',
     'url':'https://www.chinawriter.com.cn/n1/2026/0714/c404024-40760284.html','role':'作者直接确认八公山核心情节及虚构原则'},
    {'id':'author-summary','title':'《绍宋》第四卷卷末总结（作者）',
     'url':'https://www.xxsy.net/chapter/15610037104915904/49880803538612784','role':'作者确认尧山后战略收缩及架空推演'},
    {'id':'huolu','title':'《绍宋》第六卷第六章 获鹿（官方公开预览）',
     'url':'https://www.xs.cn/chapter/15610037104915904/53918279106274074','role':'太原集结后向井陉、河北进军'},
    {'id':'yanjing','title':'《绍宋》作者番外（上）授权页面',
     'url':'https://www.xxsy.net/bookquery/ycmigtnjmixa','role':'作者番外确认后期燕京都城'},
    {'id':'yaoshan-geography','title':'陕西地方志《蒲城县志》尧山地理',
     'url':'https://dfz.shaanxi.gov.cn/zslm/fzzlk/xbsxsxz/xbsxz/wns_16202/201405/P020240923619505277383.pdf',
     'role':'尧山为陕西蒲城县北约12公里的山地；故事地点仅示意'},
    {'id':'natural-earth','title':'Natural Earth 1:50m land',
     'url':'https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-land/','role':'自然海岸底图'},
    {'id':'natural-earth-license','title':'Natural Earth Terms of Use',
     'url':'https://www.naturalearthdata.com/about/terms-of-use/','role':'公有领域许可'}]
sources.extend([
    {'id':'chgis-tgaz','title':'Harvard / Fudan CHGIS：TGAZ历史治所地名与坐标（1080年存续记录）',
     'url':'https://github.com/cga-harvard/tgaz/tree/master/data/csv',
     'role':'每个固定地图分格的真实地名、点坐标、年代和原记录ID；不提供历史疆界'},
    {'id':'chgis-license','title':'CHGIS V6数据与许可说明',
     'url':'https://chgis.fas.harvard.edu/data/chgis/v6/',
     'role':'TGAZ CSV目录声明GPLv3；CHGIS主站另列学术非商业条款，原文保存在本地来源说明'}])

data = dict(version=2,id='shaosong-study-campaign-v2',title='山河复归图',
    disclaimer='地名据CHGIS真实历史记录，分格及收复进度为学习示意，非宋代疆界。',
    viewBox='0 0 960 760',bounds=[105,23,122,41],
    projection='regional schematic longitude-latitude; intentionally fitted for study interface',
    totalCells=MAP_CELL_COUNT,totalLostArea=round(total_lost_area,8),
    initialLandFraction=round(base.area/land.area,8),
    landPath=svg_path(land),basePath=svg_path(base),lostPath=svg_path(lost),
    landFillRule='evenodd',baseLabel='南方根据地',
    baseNote='南方连片为起始根据地意象，不代表某年真实控制区；待收复地仅在其北侧。',
    clippingNote='Cell paths are already clipped to mainland minus starting base. Render with fill-rule=evenodd. Cell pieces are convex triangles in the identical SVG coordinate system.',
    rivers=rivers,nodes=[],stages=[],milestones=milestones,cells=cells,sources=sources,
    landSource=dict(name='Natural Earth 1:50m land',license='Public domain',
        url='https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',
        sha256=hashlib.sha256(source_file.read_bytes()).hexdigest()),
    historicalPlaceSource=gazetteer['source_catalog'][0],historicalPlaceReferenceYear=1080,
    narrativeNote='固定203个历史治所点作为地图设计，与题库数量无关；当前题库已复习数/当前总题数决定新增红色占全部待复习地图面积的比例。部分地块可按准确面积连续填色，沿南至北推进。',
    geometryChecks=dict(lostArea=round(lost.area,8),cellAreaSum=round(total_lost_area,8),
        unionDifference=round(union_error,10),overlapArea=round(overlap_error,10),
        relativeAreaError=abs(total_lost_area-lost.area)/lost.area,
        triangleCount=sum(len(c['pieces']) for c in cells),coordinateDecimals=PRECISION,
        uniqueHistoricNames=len({c['name'] for c in cells}),
        minLatitude=cells[0]['lat'],maxLatitude=cells[-1]['lat']))
(ROOT/'campaign-data.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')

svg=['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 760">',
     '<rect width="960" height="760" fill="#eee8dc"/>',
     f'<path d="{data["landPath"]}" fill="#c4bfb6" stroke="#555047" stroke-width="1.6" fill-rule="evenodd"/>',
     f'<path d="{data["basePath"]}" fill="#a8322a" fill-rule="evenodd"/>']
svg.extend(f'<path d="{c["path"]}" fill="#c4bfb6" stroke="#eee8dc" stroke-width="1" fill-rule="evenodd"/>' for c in cells)
svg.extend(f'<text x="{c["x"]}" y="{c["y"]}" text-anchor="middle" font-size="7.5" fill="#352d27">{c["name"]}</text>' for c in cells)
svg.append('</svg>')
(HERE/'map-initial.svg').write_text(''.join(svg),encoding='utf-8')
print(json.dumps(dict(cells=len(cells),milestones=len(milestones),
    availableHistoricPlaces=len(candidates),bytes=(ROOT/'campaign-data.json').stat().st_size,
    geometryChecks=data['geometryChecks']),ensure_ascii=True))
