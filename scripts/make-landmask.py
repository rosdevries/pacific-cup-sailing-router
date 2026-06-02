# make-landmask.py — clip GSHHG (high-res) to the California–Hawaii corridor and
# bake a 1-byte/px land/sea raster (land=255). Source: GSHHG via the Basemap data package.
import numpy as np, base64
from mpl_toolkits.basemap import Basemap
from PIL import Image, ImageDraw

LONMIN,LONMAX,LATMIN,LATMAX = -160.5,-116.0,16.0,42.5   # must match the demo's VIEW bbox
RES = 0.02                                              # degrees/cell (~1.2 nm)
NX, NY = round((LONMAX-LONMIN)/RES), round((LATMAX-LATMIN)/RES)

m = Basemap(projection='cyl', llcrnrlon=LONMIN, llcrnrlat=LATMIN,
            urcrnrlon=LONMAX, urcrnrlat=LATMAX, resolution='h')  # 'h' = GSHHG high

img = Image.new('L',(NX,NY),0); draw = ImageDraw.Draw(img)
def topx(lon,lat): return ((lon-LONMIN)/(LONMAX-LONMIN)*NX, (LATMAX-lat)/(LATMAX-LATMIN)*NY)
nland=nlake=0
for (xs,ys),t in zip(m.coastpolygons, m.coastpolygontypes):
    pts=[topx(lo,la) for lo,la in zip(xs,ys)]
    if len(pts)<3: continue
    if t in (1,3): draw.polygon(pts, fill=255); nland+=1      # land / island-in-lake
    else:          draw.polygon(pts, fill=0);   nlake+=1      # lake / pond -> sea

arr=np.asarray(img)
def at(lat,lon):
    return int(arr[int((LATMAX-lat)/(LATMAX-LATMIN)*NY), int((lon-LONMIN)/(LONMAX-LONMIN)*NX)])
print(f"dims {NX}x{NY}  land polys {nland}  lakes {nlake}  land fraction {100*arr.mean()/255:.2f}%")
print("Kaneohe Bay  (want SEA  0):", at(21.4806,-157.7725))
print("Honolulu     (want LAND255):", at(21.305,-157.858))
print("mid-Pacific  (want SEA  0):", at(28,-145))
print("Sacramento   (want LAND255):", at(38.58,-121.49))
print("SF start     (want SEA  0):", at(37.80,-122.60))        # 5 nm WSW of Golden Gate
print("Diamond Head routeDest (want SEA 0):", at(21.19,-157.83))  # 3 nm S of Black Point
print("Big Island   (want LAND255):", at(19.6,-155.5))
img.save("landmask.png")
raw=open("landmask.png","rb").read()
open("landmask.b64.txt","w").write(base64.b64encode(raw).decode())
print(f"PNG {len(raw)/1024:.1f} KB  -> base64 {len(base64.b64encode(raw))/1024:.1f} KB")
