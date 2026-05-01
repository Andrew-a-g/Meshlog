<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="referrer" content="strict-origin">
    <link id="favicon" rel="icon" type="image/x-icon" href="assets/favicon/faviconw.ico">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossorigin=""/>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
        crossorigin=""></script>
    <script src=" https://cdn.jsdelivr.net/npm/leaflet-polylineoffset@1.1.1/leaflet.polylineoffset.min.js "></script>
    <script src="https://cdn.jsdelivr.net/npm/linkifyjs@4.3.2/dist/linkify.min.js"
        integrity="sha256-3RgHec0J2nciPAIndkHOdN/WMH98UhLzLRsf+2MOiiY="
        crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/linkify-string@4.3.2/dist/linkify-string.min.js"
        integrity="sha256-b6wRq6tXNDnatickDjAMTffu2ZO2lsaV5Aivm+oh2s4="
        crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/leaflet-polylinedecorator@1.6.0/dist/leaflet.polylineDecorator.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
    <script src="assets/js/meshlog.js?v=<?=filemtime("assets/js/meshlog.js")?>"></script>
    <link rel="stylesheet" href="assets/css/style.css?v=<?=filemtime("assets/css/style.css")?>">
    <title>MeshLog</title>
</head>
<body>

<div id="error"></div>
<div id="container">
<div id="leftbar">
    <div class="settings" id="settings-reporter-filter">
    </div>
    <div class="settings" id="settings-types">
    </div>
    <div class="settings" id="settings-reporters">
    </div>
    <div class="filter-warning" id="logs-filter-warning" hidden></div>
    <div id="logs"></div>
</div>
<div id="midbar">
    <div class="resize-bar" id="leftdrag"></div>
    <div id="map">
        <div id="warning" hidden></div>
    </div>
    <div class="resize-bar" id="rightdrag"></div>
</div>
<div class="resize-bar resize-bar-horizontal" id="mobile-vdrag"></div>
<div id="mobile-tabs" role="tablist" aria-label="Mobile sidebar tabs">
    <button type="button" class="mobile-tab-btn active" data-mobile-tab-target="logs" role="tab" aria-selected="true">Messages</button>
    <button type="button" class="mobile-tab-btn" data-mobile-tab-target="contacts" role="tab" aria-selected="false">Contacts</button>
</div>
<div id="rightbar">
    <div class="settings" id="settings-contacts">
    </div>
    <div class="settings" id="about">MeshLog Web</div>
    <div class="filter-warning" id="contacts-filter-warning" hidden></div>
    <div id="contacts"></div>
</div>

<div id="context-menu" class="menu">
</div>
</div>
<span id="header" style="position: fixed; top: 40px; right: 48px;"></span>
<script>

// Setup linkifyjs default options (default to ouse page)
linkify.options.defaults = {...linkify.options.defaults, defaultProtocol: "https", target: "_blank"}

// resize bars

class Bar {
    constructor(id, width) {
        this.tmpWidth = undefined;
        this.dom = document.getElementById(id);
        this.setWidth(width);
    }

    setWidth(w) {
        this.width = w;
        this.dom.style.width = `${w}%`;
    }

    setTmpWidth(w) {
        if (this.tmpWidth == undefined) {
            this.tmpWidth = this.width;
            this.setWidth(w);
        }
    }

    resetWidth() {
        if (this.tmpWidth != undefined) {
            this.setWidth(this.tmpWidth);
            this.tmpWidth = undefined;
        }
    }
}

class Drags {
    constructor(id) {
        this.pairs = [];
        this.container = document.getElementById(id);

        const self = this;

        this.container.addEventListener("mousemove", function (e) {
            e.preventDefault();

            let pair = undefined;
            for (var i=0;i<self.pairs.length;i++) {
                if (self.pairs[i].drag) {
                    pair = self.pairs[i];
                    break;
                }
            }

            if (!pair) return;

            let split = ( e.x - pair.x0) / pair.width;

            if (split < 0.05) split = 0.05;

            let ppLeft = pair.sum * split; // % left

            pair.left.setWidth(ppLeft);
            pair.right.setWidth(pair.sum - ppLeft);
            
            map.invalidateSize();
        });

        this.container.addEventListener("mouseup", function () {
            self.cancelDrag();
        });
    }

    add(pair) {
        pair.bind(this);
        this.pairs.push(pair);
    }

    cancelDrag() {
        for (var i=0;i<this.pairs.length;i++) {
            this.pairs[i].drag = false;
        }
    }

}

class DragPair {
    constructor(id, left, right) {
        this.drag = false;
        this.left = left;
        this.right = right;
        this.bar = document.getElementById(id);
        this.calc();

        const self = this;

        this.bar.addEventListener("mousedown", function () {
            if (self.drags) self.drags.cancelDrag();
            self.calc();
            self.drag = true;
        });
    }

    calc() {
        this.x0 = this.left.dom.getBoundingClientRect().left;
        this.x1 = this.right.dom.getBoundingClientRect().right;
        this.width = this.x1 - this.x0;

        this.sum = this.percent2num(this.left.dom.style.width) + this.percent2num(this.right.dom.style.width);
    }

    percent2num(percent) {
        return parseFloat(percent.replaceAll("%","").trim());
    }

    bind(drags) {
        this.drags = drags;
    }
}

const MOBILE_BREAKPOINT = 900;
const MOBILE_DEFAULT_MAP_HEIGHT = 320;
const MOBILE_MIN_MAP_HEIGHT = 180;
const MOBILE_MIN_PANEL_HEIGHT = 60;
const MOBILE_DRAG_HIT_HEIGHT = 28;

const leftBar = new Bar("leftbar", 33);
const middleBar = new Bar("midbar", 47);
const rightBar = new Bar("rightbar", 20);
const container = document.getElementById("container");
const leftBarDom = document.getElementById("leftbar");
const rightBarDom = document.getElementById("rightbar");
const mobileVDrag = document.getElementById("mobile-vdrag");
const mobileTabButtons = Array.from(document.querySelectorAll("[data-mobile-tab-target]"));

let mobileDrag = false;
let mobileMapHeight = Number(Settings.get("mobile.mapHeight", MOBILE_DEFAULT_MAP_HEIGHT)) || MOBILE_DEFAULT_MAP_HEIGHT;
let mobileActiveTab = Settings.get("mobile.activeTab", "logs") || "logs";

const dragLeft = new DragPair("leftdrag", leftBar, middleBar);
const dragRight = new DragPair("rightdrag", middleBar, rightBar);

function getViewportHeight() {
    const heights = [
        window.innerHeight,
        document.documentElement?.clientHeight,
        window.visualViewport?.height
    ]
        .map(value => Number(value) || 0)
        .filter(value => value > 0);

    return heights.length ? Math.max(...heights) : MOBILE_DEFAULT_MAP_HEIGHT;
}

function clampMobileMapHeight(height) {
    const viewportHeight = getViewportHeight();
    const maxHeight = Math.max(MOBILE_MIN_MAP_HEIGHT, viewportHeight - MOBILE_MIN_PANEL_HEIGHT);
    return Math.max(MOBILE_MIN_MAP_HEIGHT, Math.min(height, maxHeight));
}

function setMobileMapHeight(height, persist=true) {
    mobileMapHeight = clampMobileMapHeight(height);
    container.style.setProperty("--mobile-map-height", `${mobileMapHeight}px`);
    if (persist) {
        Settings.set("mobile.mapHeight", mobileMapHeight);
    }
}

function setMobileTab(tab, persist=true) {
    mobileActiveTab = tab === "contacts" ? "contacts" : "logs";
    const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;

    leftBarDom.hidden = isMobile && mobileActiveTab !== "logs";
    rightBarDom.hidden = isMobile && mobileActiveTab !== "contacts";

    mobileTabButtons.forEach(button => {
        const active = button.dataset.mobileTabTarget === mobileActiveTab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    if (persist) {
        Settings.set("mobile.activeTab", mobileActiveTab);
    }
}

function isNearMobileDragHandle(target, clientY) {
    if (window.innerWidth > MOBILE_BREAKPOINT) return false;
    if (target?.closest?.("#mobile-tabs")) return false;

    const rect = mobileVDrag.getBoundingClientRect();
    if (!rect.height) return false;

    const centerY = rect.top + (rect.height / 2);
    const halfHit = MOBILE_DRAG_HIT_HEIGHT / 2;

    return clientY >= centerY - halfHit && clientY <= centerY + halfHit;
}
function resize() {
    if (window.innerWidth <= MOBILE_BREAKPOINT) {
        leftBar.setTmpWidth(100);
        middleBar.setTmpWidth(100);
        rightBar.setTmpWidth(100);
        setMobileTab(mobileActiveTab, false);
        mobileVDrag.hidden = false;
    } else {
        leftBar.resetWidth();
        middleBar.resetWidth();
        rightBar.resetWidth();
        mobileVDrag.hidden = true;
        leftBarDom.hidden = false;
        rightBarDom.hidden = false;
        container.style.removeProperty("--mobile-map-height");
    }

    if (typeof map !== "undefined") {
        requestAnimationFrame(() => map.invalidateSize());
    }
}

const drags = new Drags("container");
drags.add(dragLeft);
drags.add(dragRight);

mobileTabButtons.forEach(button => {
    button.addEventListener("click", function() {
        setMobileTab(button.dataset.mobileTabTarget);
    });
});

window.addEventListener("pointerdown", function(e) {
    if (!isNearMobileDragHandle(e.target, e.clientY)) return;

    mobileDrag = true;
    mobileVDrag.setPointerCapture?.(e.pointerId);
    e.preventDefault();
});

window.addEventListener("pointermove", function(e) {
    if (!mobileDrag) return;

    const top = container.getBoundingClientRect().top;
    setMobileMapHeight(e.clientY - top, false);

    if (typeof map !== "undefined") {
        map.invalidateSize();
    }
});

window.addEventListener("pointerup", function() {
    if (!mobileDrag) return;

    mobileDrag = false;
    setMobileMapHeight(mobileMapHeight);

    if (typeof map !== "undefined") {
        map.invalidateSize();
    }
});

resize();

var map = L.map('map').setView([56.96894, 24.14520], 10);
let layerOsm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

let layerOsmDark = L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

let layerOsmLight = L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png ', {
    maxZoom: 19,
    crossOrigin: true,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

let layerOsmD = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    className: 'dark-tiles'
});

L.control.layers({
    "OpenStreetMap": layerOsm,
    "OpenStreetMap (CSS-Filter Dark)": layerOsmD,
    "OpenStreetMap (carto Light)": layerOsmLight,
    "OpenStreetMap (Carto Dark)": layerOsmDark,
}, {}).addTo(map);

layerOsm.addTo(map);

var meshlog = new MeshLog(
    map,
    "logs",
    "contacts",
    "settings-types",
    "settings-reporter-filter",
    "settings-reporters",
    "settings-contacts",
    "warning",
    "error",
    "context-menu",
);
meshlog.loadAll();
meshlog.applyAutorefreshSetting();

</script>
</body>
</html>
