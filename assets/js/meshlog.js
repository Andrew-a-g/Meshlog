class Settings {
    static get(key, def=undefined) {
        if (!localStorage.hasOwnProperty(key)) {
            localStorage[key] = def;
        }
        return localStorage[key];
    }

    static getBool(key, def=undefined) {
        if (!localStorage.hasOwnProperty(key)) {
            localStorage[key] = def;
        }
        return localStorage[key] === "true";
    }

    static set(key, value) {
        localStorage[key] = value;
    }
}

function getClockOutOfSyncWarning(senderTimeText, sentAt, createdAt) {
    const threshold = 1000 * 60 * 30;
    if (!Number.isFinite(sentAt) || !Number.isFinite(createdAt)) return null;

    if (createdAt - sentAt > threshold) {
        return {
            icon: "⚠️⏪",
            text: `Clock out of sync. Sender time is behind: ${senderTimeText}`,
        };
    }

    if (sentAt - createdAt > threshold) {
        return {
            icon: "⚠️⏩",
            text: `Clock out of sync. Sender time is ahead: ${senderTimeText}`,
        };
    }

    return null;
}

function formatAdvertInterval(totalSeconds) {
    const seconds = Number(totalSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) return "";

    const totalMinutes = Math.round(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

class MeshLogObject {
    static idPrefix = "";

    constructor(meshlog, data) {
        this._meshlog = meshlog;
        this.data = {}; // db data
        this.flags = {};
        this.dom = null;
        this.time = 0; // created_at
        this.merge(data);
    }

    merge(data) {
        // App shouldn't change data. It is updated on new advertisements
        this.data = {...this.data, ...data};
        this.time = new Date(data.created_at).getTime();
    }

    // override
    createDom(recreate = false) {}
    updateDom() {}

    static onclick(e) {}
    static onmouseover(e) {}
    static onmouseout(e) {}
    static oncontextmenu(e) {}
}

class MeshLogReporter extends MeshLogObject {
    constructor(meshlog, data) {
        super(meshlog, data);
        this.contact_id = -1;
        this.getContactId();
    }

    getStyle() {
        if (typeof this.data.style === "object" && this.data.style !== null) {
            return this.data.style;
        }

        try {
            return JSON.parse(this.data.style ?? "{}");
        } catch (error) {
            return {
                color: this.data.style ?? "#888"
            };
        }
    }

    getSettingsKey() {
        return `reporters.${this.data.id}.enabled`;
    }

    isEnabled() {
        return Settings.getBool(this.getSettingsKey(), true);
    }

    createSettingsDom(recreate = false) {
        if (this.dom?.settings && !recreate) return this.dom.settings;

        if (this.dom?.settings?.container?.parentNode) {
            this.dom.settings.container.parentNode.removeChild(this.dom.settings.container);
        }

        let container = document.createElement("label");
        let input = document.createElement("input");
        let name = document.createElement("span");

        container.classList.add("reporter-filter-item");
        input.type = "checkbox";
        input.checked = this.isEnabled();
        input.onchange = (e) => {
            Settings.set(this.getSettingsKey(), e.target.checked);
            this._meshlog.onReporterFilterChanged();
        };

        name.classList.add("reporter-filter-name");
        name.innerText = this.data.name;

        container.append(input);
        container.append(name);

        this.dom = this.dom ?? {};
        this.dom.settings = {
            container,
            input,
            name,
        };

        this.updateSettingsDom();
        return this.dom.settings;
    }

    updateSettingsDom() {
        if (!this.dom?.settings) return;

        const style = this.getStyle();
        const textColor = style.color ?? "#888";
        const strokeColor = style.stroke ?? textColor;
        const strokeWeight = style.weight ?? "1px";

        this.dom.settings.input.checked = this.isEnabled();
        this.dom.settings.container.style.color = textColor;
        this.dom.settings.name.style.color = textColor;
        this.dom.settings.container.style.border = `solid ${strokeWeight} ${strokeColor}`;
        this.dom.settings.container.classList.toggle("disabled", !this.isEnabled());
    }

    getContactId() {
        if (this.contact_id == -1) {
            let contact = Object.values(this._meshlog.contacts)
                .find(obj => obj.data.public_key == this.data.public_key);
            if (contact) {
                this.contact_id = contact.data.id;
            }
        }

        return this.contact_id;
    }
}

class MeshLogChannel extends MeshLogObject {
    constructor(meshlog, data) {
        super(meshlog, data);
    }

    isEnabled() {
        return Settings.getBool(`channels.${this.data.id}.enabled`, true);
    }

    createDom(recreate = false) {
        if (this.dom && !recreate) return this.dom;

        if (this.dom && this.dom.container && this.dom.container.parentNode) {
            this.dom.container.parentNode.removeChild(this.dom.container);
            this.dom = null;
        }

        const self = this;

        let cb = this._meshlog.__createCb(
            this.data.name,
            '',
            `channels.${this.data.id}.enabled`,
            this.isEnabled(),
            (e) => {
                this.enabled = e.target.checked;
                self._meshlog.__onTypesChanged();
            }
        );

        this.dom = {
            cb: cb,
        };

        return this.dom;
    }
}

class MeshLogContact extends MeshLogObject {
    constructor(meshlog, data) {
        super(meshlog, data);
        this.adv = null;
        this.last = null;
        this.telemetry = null;
        this.marker = null;
        this.marker_icon_mode = null;
        this.marker_displayed = true;
        this.marker_opacity = 1;
        this.marker_zindex = 2;
        this.marker_tooltip = null;

        this.flags.dupe = false;
        this.hash = data.public_key.substr(0, 2 * data.hash_size).toLowerCase();
        this.neighbors_visible = false;

        if (data.advertisement) {
            this.adv = new MeshLogAdvertisement(meshlog, data.advertisement);
            this.last = this.adv;
            delete data.advertisement;
        }

        if (data.telemetry) {
            this.telemetry = data.telemetry; // todo: use object
            delete data.telemetry;
        }
    }

    static onclick(e) {
        this.expanded = !this.expanded;
        this.updateDom();
    }

    static onmouseover(e) {
        // Show marker
        const descid = `c_${this.data.id}`;
        this._meshlog.layer_descs[descid] = {
            paths: [],
            markers: new Set().add(this.data.id),
            warnings: []
        }
        this._meshlog.updatePaths();
    }

    static onmouseout(e) {
        const descid = `c_${this.data.id}`;
        delete this._meshlog.layer_descs[descid];
        this._meshlog.updatePaths();
    }

    static oncontextmenu(e) {
        e.preventDefault();

        this._meshlog.dom_contextmenu
        const menu = this._meshlog.dom_contextmenu;

        while (menu.hasChildNodes()) {
            menu.removeChild(menu.lastChild);
        }

        let saveGpx = (data, name) => {
            let gpxContent = `<?xml version="1.0" encoding="UTF-8"?>\n`;
            gpxContent += `<gpx version="1.1" creator="Meshlog">\n`;
            gpxContent += data;
            gpxContent += `</gpx>`;

            const blob = new Blob([gpxContent], { type: "application/gpx+xml" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.click();
        };

        const c = this;

        let miGpx = document.createElement("div");
        miGpx.classList.add('menu-item');
        miGpx.innerText = "Export to GPX";
        miGpx.onclick = (e) => {
            if (c.adv) {
                const wpt = `<wpt lat="${c.adv.data.lat}" lon="${c.adv.data.lon}"><name>${escapeXml(c.data.name)}</name></wpt>\n`;
                saveGpx(wpt, `meshlog_contact_${c.data.id}.gpx`);
            }
        };

        let miAll = document.createElement("div");
        miAll.classList.add('menu-item');
        miAll.innerText = "Export all to GPX";
        miAll.onclick = (e) => {
            let wpt = '';
            Object.entries(c._meshlog.contacts).forEach(([k,v]) => {
                if (v.adv && (v.adv.lat != 0 || v.adv.lon != 0)) {
                    wpt += `<wpt lat="${v.adv.data.lat}" lon="${v.adv.data.lon}"><name>${escapeXml(v.data.name)}</name></wpt>\n`;
                }
            });
            saveGpx(wpt, `meshlog_contacts.gpx`);
        };

        menu.appendChild(miGpx);
        menu.appendChild(miAll);

        menu.style.display = 'block';
        menu.style.left = `${e.pageX}px`;
        menu.style.top = `${e.pageY}px`;
    }

    getLayerDescPrefix() {
        return `nb${this.data.id}:`;
    }

    showNeighbors(rx=true, tx=true, markers=false) {
        if (this.isClient()) return; // not supported

        let contactPairs = {
            pairs: {},
            addPair: (src, dst, options = {}) => {
                if (!src || !dst) return;
                if (!src.adv || !dst.adv) return;
                if (src.adv.data.lat == 0 && src.adv.data.lon == 0) return;

                const key = `${src.data.id}_${dst.data.id}`;

                if (!contactPairs.pairs.hasOwnProperty(key)) {
                    contactPairs.pairs[key] = {
                        count: 1,
                        src,
                        dst,
                        dashed: options.dashed === true,
                        warnings: options.skipWarning ? [options.skipWarning] : [],
                    };
                } else {
                    contactPairs.pairs[key].count += 1;
                    contactPairs.pairs[key].dashed = contactPairs.pairs[key].dashed || options.dashed === true;
                    if (options.skipWarning && !contactPairs.pairs[key].warnings.includes(options.skipWarning)) {
                        contactPairs.pairs[key].warnings.push(options.skipWarning);
                    }
                }
            }
        };

        Object.entries(this._meshlog.messages).forEach(([k,m]) => {
            let src_id = m.data.contact_id;
            let src = this._meshlog.contacts[src_id] ?? false;

            if (!src) return;

            m.reports.forEach(r => {
                let path = r.data.path ?? undefined;
                if (path == undefined) return; 
                let hashes = path ? path.split(",") : [];

                let reporter = this._meshlog.reporters[r.data.reporter_id] ?? false;
                if (!reporter) return;
                if (!reporter.isEnabled()) return;
                

                // If message is from this contact, neighbor is first path hash
                if (src === this) {
                    if (hashes.length == 0) {
                        // direct to reporter
                        if (reporter.getContactId() == -1) return;

                        contactPairs.addPair(src, this._meshlog.contacts[reporter.getContactId()]);
                    } else {
                        // to neareset contact
                        let nearest = this._meshlog.findNearestContact(this.data.lat, this.data.lon, hashes[0], true);
                        if (nearest && nearest.result) {
                            const meta = this._meshlog.getPathResolutionMeta(src.data.public_key, hashes[0], nearest);
                            contactPairs.addPair(src, nearest.result, meta);
                        }
                    }
                } else {
                    // decode hashes
                    if (hashes.length == 0) return;
                    let idx = hashes.indexOf(this.hash);
                    if (idx < 0) return;
                    idx += 1;

                    // Link contains contact hash
                    // Simulate link up to contact and check if might be possible

                    let prev = {
                        lat: reporter.data.lat,
                        lon: reporter.data.lon,
                        contact_id: reporter.getContactId()
                    };

                    let end = hashes.length + 1;
                    let contacts = {0: src, [end]: this._meshlog.contacts[reporter.getContactId()] ?? null}

                    for (let i=hashes.length-1;i>=0;i--) {
                        let hash = hashes[i];
                        let nearest = this._meshlog.findNearestContact(prev.lat, prev.lon, hash, true);

                        // Valid repeater found?
                        if (nearest) {
                            if (nearest.matches > 1) {
                                // desc.warnings.push(`Multiple paths (${nearest.matches}) detected to ${hash}. Showing shortest.`);
                            }

                            let current = {
                                lat: nearest.result.adv.data.lat,
                                lon: nearest.result.adv.data.lon,
                                contact_id: nearest.result.data.id
                            };

                            contacts[i+1] = nearest.result;
                            prev = current;
                        } else {
                            contacts[i+1] = null;
                            console.log(`no nearest for hash ${hash}`);
                        }
                    }

                    let cThis = contacts[idx];
                    let cPrev = contacts[idx-1];
                    let cNext = contacts[idx+1];

                    if (!cThis || cThis != this) return;
                    if (cNext) { contactPairs.addPair(cThis, cNext); }
                    if (cPrev) { contactPairs.addPair(cPrev, cThis); }
                }
            });
        });

        Object.entries(contactPairs.pairs).forEach(([k,p]) => {
            let isTx = p.src == this;
            if (isTx && !tx) return;
            if (!isTx && !rx) return;

            let key = `${this.getLayerDescPrefix()}${k}`;
            this._meshlog.layer_descs[key] = {
                paths: [
                    new MeshLogLinkLayer(
                        {
                            lat: p.src.adv.data.lat,
                            lon: p.src.adv.data.lon,
                            contact_id: p.src.data.id
                        },
                        {
                            lat: p.dst.adv.data.lat,
                            lon: p.dst.adv.data.lon,
                            contact_id: p.dst.data.id
                        },
                        {
                            data: {
                                id: 0
                            },
                            getStyle: () => {
                                return {
                                    color: isTx ? 'red' : 'blue',
                                    strokeColor: 'white',
                                    strokeWeight: '1px'
                                };
                            }
                        },
                        false,
                        {
                            dashed: p.dashed,
                            skipWarning: p.warnings[0] ?? null,
                        }
                    )
                ],
                markers: markers ? new Set([p.src.data.id, p.dst.data.id]) : new Set([this.data.id]),
                warnings: p.warnings ?? []
            }
        });

        this._meshlog.updatePaths();
        this.neighbors_visible = true;
    }

    hideNeighbors() {
        let prefix = this.getLayerDescPrefix();
        Object.keys(this._meshlog.layer_descs).forEach(k => {
            if (k.startsWith(prefix)) {
                delete this._meshlog.layer_descs[k];
            }
        });
        this._meshlog.updatePaths();
        this.neighbors_visible = false;
    }

    getQrContents() {
        const name = encodeURIComponent(this.adv?.data?.name ?? this.data.name ?? "");
        const publicKey = encodeURIComponent(this.data.public_key ?? "");
        const type = encodeURIComponent(this.adv?.data?.type ?? "");
        return `meshcore://contact/add?name=${name}&public_key=${publicKey}&type=${type}`;
    }

    copyQrContents(button = null) {
        const contents = this.getQrContents();
        const resetLabel = button ? button.innerText : "";

        const onSuccess = () => {
            if (!button) return;
            button.innerText = "Copied";
            button.classList.add("active");
            setTimeout(() => {
                button.innerText = resetLabel;
                button.classList.remove("active");
            }, 1200);
        };

        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(contents)
                .then(onSuccess)
                .catch(() => {
                    window.prompt("Copy link:", contents);
                });
            return;
        }

        window.prompt("Copy link:", contents);
    }

    ensureQrCode() {
        if (!this.dom?.detailsQr) return;

        const contents = this.getQrContents();
        if (this.dom.detailsQr.dataset.contents === contents && this.dom.detailsQr.childNodes.length > 0) {
            return;
        }

        while (this.dom.detailsQr.firstChild) {
            this.dom.detailsQr.removeChild(this.dom.detailsQr.firstChild);
        }

        this.dom.detailsQr.dataset.contents = contents;

        if (typeof QRCode === "undefined") {
            let fallback = document.createElement("div");
            fallback.classList.add("detail-qr-fallback");
            fallback.innerText = contents;
            this.dom.detailsQr.append(fallback);
            return;
        }

        new QRCode(this.dom.detailsQr, {
            text: contents,
            width: 192,
            height: 192,
            colorDark: "#f5f5f5",
            colorLight: "#262626",
            correctLevel: QRCode.CorrectLevel.M
        });
    }

    createDom(recreate = false) {
        if (this.dom && !recreate) return this.dom;

        if (this.dom && this.dom.container && this.dom.container.parentNode) {
            this.dom.container.parentNode.removeChild(this.dom.container);
            this.dom = null;
        }

        let divContainer = document.createElement("div");
        let divContact = document.createElement("div");
        let divDetails = document.createElement("div");
        let divLine1 = document.createElement("div");
        let divLine2 = document.createElement("div");

        divContact.classList.add("log-entry", "contact-row");
        divContact.instance = this;
        divDetails.hidden = true;
        divLine1.classList.add("log-entry-info", "contact-row-top");
        divLine2.classList.add("log-entry-msg", "contact-row-bottom");

        let imType = document.createElement("img");
        let spDate = document.createElement("span");
        let spPrefix = document.createElement("span");
        let spHash = document.createElement("span");
        let spName = document.createElement("span");
        let spMeta = document.createElement("span");
        let spTelemetry = document.createElement("span");

        imType.classList.add(...['ti']);
        spDate.classList.add(...['sp', 'c']);
        spHash.classList.add(...['sp', 'prio-4']);
        spName.classList.add(...['sp', 't', 'contact-name']);
        spPrefix.classList.add(...['contact-inline-warning']);
        spMeta.classList.add(...['sp', 'sm', 'contact-inline-meta']);
        spTelemetry.classList.add(...['contact-inline-text']);

        divLine1.append(spDate);
        spMeta.append(spPrefix);
        spMeta.append(spTelemetry);
        divLine1.append(spMeta);
        divLine2.append(imType);
        divLine2.append(spHash);
        divLine2.append(spName);
        divContact.append(divLine1);
        divContact.append(divLine2);

        let divDetailsType = document.createElement("div");
        let divDetailsFirst = document.createElement("div");
        let divDetailsInterval = document.createElement("div");
        let divDetailsKey = document.createElement("div");
        let divDetailsTelemetry = document.createElement("div");
        let divDetailsActions = document.createElement("div");
        let divDetailsQr = document.createElement("div");
        let btnShowNeighbors = document.createElement("button");
        let btnShowQr = document.createElement("button");
        let btnCopyQr = document.createElement("button");

        divDetails.append(divDetailsType);
        divDetails.append(divDetailsFirst);
        divDetails.append(divDetailsInterval);
        divDetails.append(divDetailsKey);
        divDetails.append(divDetailsTelemetry);
        divDetails.append(divDetailsActions);
        divDetails.append(divDetailsQr);

        if (!this.isClient()) {
            divDetailsActions.append(btnShowNeighbors);
        }

        divDetailsActions.append(btnShowQr);
        divDetailsActions.append(btnCopyQr);

        divContainer.append(divContact);
        divContainer.append(divDetails);

        const self = this;
        divDetailsActions.classList.add("detail-actions");
        divDetailsQr.classList.add("detail-qr");
        divDetailsQr.hidden = true;
        btnShowNeighbors.classList.add('btn');
        btnShowNeighbors.innerText = "Show Neighbors";
        btnShowNeighbors.onclick = (e) => {
            if (self.neighbors_visible) {
                self.hideNeighbors();
            } else {
                self.showNeighbors();
            }

            if (self.neighbors_visible) {
                e.target.innerText = "Hide Neighbors";
                e.target.classList.add("active");
            } else {
                e.target.innerText = "Show Neighbors";
                e.target.classList.remove("active");
            }
        }

        btnShowQr.classList.add('btn');
        btnShowQr.innerText = "Show QR";
        btnShowQr.onclick = (e) => {
            const visible = !divDetailsQr.hidden;

            if (visible) {
                divDetailsQr.hidden = true;
                e.target.innerText = "Show QR";
                e.target.classList.remove("active");
                return;
            }

            self.ensureQrCode();
            divDetailsQr.hidden = false;
            e.target.innerText = "Hide QR";
            e.target.classList.add("active");
        };

        btnCopyQr.classList.add('btn');
        btnCopyQr.innerText = "Copy Link";
        btnCopyQr.onclick = () => {
            self.copyQrContents(btnCopyQr);
        };

        this.dom = {
            container: divContainer,
            contact: divContact,
            details: divDetails,

            contactDate: spDate,
            contactHash: spHash,
            contactName: spName,
            contactMeta: spMeta,
            contactPrefix: spPrefix,
            contactIcon: imType,
            contactTelemetry: spTelemetry,

            detailsType: divDetailsType,
            detailsFirst: divDetailsFirst,
            detailsInterval: divDetailsInterval,
            detailsKey: divDetailsKey,
            detailsTelemetry: divDetailsTelemetry,
            detailsActions: divDetailsActions,
            detailsQr: divDetailsQr,
            btnShowNeighbors: btnShowNeighbors,
            btnShowQr: btnShowQr,
            btnCopyQr: btnCopyQr
        };

        divContact.instance = this;
        return this.dom;
    }

    addToMap(map) {
        if (this.marker) return;
        this.map = map;

        if (!this.adv || (this.adv.data.lat == 0 && this.adv.data.lon == 0)) {
            return
        }

        this.marker = this.createMarkerLayer();
        this.applyMarkerState();
    }

    getMarkerZoomMode() {
        return this.map && this.map.getZoom() < 11 ? 'point' : 'full';
    }

    getMarkerAppearance() {
        let iconUrl = 'assets/img/tower.svg';
        let receipt = false;

        if (this.isClient()) {
            const rep = this.isReporter();
            if (rep) {
                receipt = rep.getStyle().color;
            } else {
                iconUrl = 'assets/img/person.svg';
            }
        } else if (this.isRepeater()) {
            iconUrl = 'assets/img/tower.svg';
        } else if (this.isRoom()) {
            iconUrl = 'assets/img/group.svg';
        } else if (this.isSensor()) {
            iconUrl = 'assets/img/sensor.svg';
        } else {
            iconUrl = 'assets/img/unknown.svg';
        }

        const extractEmoji = (str) => {
            const emojiRegex = /\p{Extended_Pictographic}/u;
            const match = str.match(emojiRegex);
            return match ? match[0] : '';
        };

        let stateClass = '';
        if (!this.isClient()) {
            if (this.isVeryExpired()) {
                stateClass = 'missing';
            } else if (this.isExpired()) {
                stateClass = 'ghosted';
            } else if (this.data.multibyte) {
                stateClass = 'multibyte';
            }
        } else if (this.data.multibyte) {
            stateClass = 'multibyte';
        }

        return {
            iconUrl,
            receipt,
            emoji: extractEmoji(this.adv?.data?.name ?? ''),
            stateClass,
        };
    }

    buildFullMarkerIcon(appearance) {
        let innerIcon;
        if (appearance.emoji) {
            innerIcon = document.createElement('span');
            innerIcon.innerText = appearance.emoji;
        } else if (appearance.receipt) {
            const hw = '20px';
            innerIcon = document.createElement('span');
            innerIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="${hw}" viewBox="0 -960 960 960" width="${hw}" fill="${appearance.receipt}"><path d="M240-80q-50 0-85-35t-35-85v-120h120v-560l60 60 60-60 60 60 60-60 60 60 60-60 60 60 60-60 60 60 60-60v680q0 50-35 85t-85 35H240Zm480-80q17 0 28.5-11.5T760-200v-560H320v440h360v120q0 17 11.5 28.5T720-160ZM360-600v-80h240v80H360Zm0 120v-80h240v80H360Zm320-120q-17 0-28.5-11.5T640-640q0-17 11.5-28.5T680-680q17 0 28.5 11.5T720-640q0 17-11.5 28.5T680-600Zm0 120q-17 0-28.5-11.5T640-520q0-17 11.5-28.5T680-560q17 0 28.5 11.5T720-520q0 17-11.5 28.5T680-480ZM240-160h360v-80H200v40q0 17 11.5 28.5T240-160Zm-40 0v-80 80Z"/></svg>`;
        } else {
            innerIcon = document.createElement('img');
            innerIcon.src = appearance.iconUrl;
        }

        let root = document.createElement("div");
        let pin = document.createElement("div");
        pin.classList.add('marker-pin');
        if (appearance.stateClass) {
            pin.classList.add(appearance.stateClass);
        }

        innerIcon.classList.add('marker-icon-img');
        root.appendChild(pin);
        root.appendChild(innerIcon);

        return L.divIcon({
            className: 'custom-div-icon',
            html: root,
            iconSize: [30, 42],
            iconAnchor: [15, 42]
        });
    }

    buildPointMarkerIcon(appearance) {
        const fillColor = appearance.receipt || {
            multibyte: '#d87dff',
            missing: '#bb6363',
            ghosted: '#dfae54',
        }[appearance.stateClass] || '#607e8c';

        return {
            renderer: this._meshlog.canvas_renderer,
            radius: 5,
            weight: 2,
            color: 'rgba(255, 255, 255, 0.9)',
            opacity: this.marker_opacity,
            fillColor,
            fillOpacity: this.marker_opacity,
        };
    }

    buildMarkerIcon() {
        const appearance = this.getMarkerAppearance();
        const mode = this.getMarkerZoomMode();
        this.marker_icon_mode = mode;
        return mode === 'point'
            ? this.buildPointMarkerIcon(appearance)
            : this.buildFullMarkerIcon(appearance);
    }

    createMarkerLayer() {
        const mode = this.getMarkerZoomMode();
        const markerConfig = this.buildMarkerIcon();

        if (mode === 'point') {
            return L.circleMarker([this.adv.data.lat, this.adv.data.lon], markerConfig);
        }

        return L.marker([this.adv.data.lat, this.adv.data.lon], {
            icon: markerConfig,
        });
    }

    isPointMarker() {
        return this.marker_icon_mode === 'point';
    }

    applyMarkerState() {
        if (!this.marker || !this.map) return;

        if (this.marker_displayed) {
            if (!this.map.hasLayer(this.marker)) {
                this.marker.addTo(this.map);
            }
        } else if (this.map.hasLayer(this.marker)) {
            this.map.removeLayer(this.marker);
        }

        if (!this.marker_displayed) return;

        if (this.isPointMarker()) {
            this.marker.setStyle({
                opacity: this.marker_opacity,
                fillOpacity: this.marker_opacity,
            });

            if (this.marker_zindex >= 1000) {
                this.marker.bringToFront();
            } else {
                this.marker.bringToBack();
            }
        } else {
            this.marker.setOpacity(this.marker_opacity);
            this.marker.setZIndexOffset(this.marker_zindex);
        }

        this.updateTooltip(this.marker_tooltip);
    }

    updateMarkerIcon() {
        if (!this.marker) return;

        const nextMode = this.getMarkerZoomMode();
        if (this.marker_icon_mode === nextMode) return;

        const tooltip = this.marker_tooltip;
        const displayed = this.marker_displayed;
        const opacity = this.marker_opacity;
        const zindex = this.marker_zindex;

        if (this.map.hasLayer(this.marker)) {
            this.map.removeLayer(this.marker);
        }

        this.marker = this.createMarkerLayer();
        this.marker_displayed = displayed;
        this.marker_opacity = opacity;
        this.marker_zindex = zindex;
        this.marker_tooltip = tooltip;
        this.applyMarkerState();
    }

    updateTooltip(tooltip = undefined) {
        if (!this.marker) return;

        if (tooltip === undefined) {
            const advertInterval = this.getAdvertisementIntervalSeconds();
            const advertIntervalLine =
                advertInterval !== null && Number.isFinite(advertInterval)
                    ? `<p class="tooltip-detail">Advert interval: ${formatAdvertInterval(advertInterval)}</p>`
                    : '';
            tooltip = `<p class="tooltip-title">${this.adv.data.name} <span class="tooltip-hash">[${this.hash}]</span></p><p class="tooltip-detail">Last heard: ${this.last.data.created_at}</p>${advertIntervalLine}`;
        }

        this.marker_tooltip = tooltip;
        this.marker.unbindTooltip();

        if (tooltip) {
            this.marker.bindTooltip(tooltip);
        }
    }

    setMarkerDisplayed(displayed) {
        if (this.marker_displayed === displayed) return;
        this.marker_displayed = displayed;
        this.applyMarkerState();
    }

    setMarkerOpacity(opacity) {
        if (this.marker_opacity === opacity) return;
        this.marker_opacity = opacity;
        this.applyMarkerState();
    }

    setMarkerZIndex(offset) {
        if (this.marker_zindex === offset) return;
        this.marker_zindex = offset;
        this.applyMarkerState();
    }

    __removeEmojis(str) {
            return str.replace(
                /([\u200D\uFE0F]|[\u2600-\u27BF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF])/g,
                ''
            );
    }

    getClockWarning() {
        if (!this.adv) return null;

        let sentAt = new Date(this.adv.data.sent_at).getTime();
        let createdAt = new Date(this.adv.data.created_at).getTime();
        return getClockOutOfSyncWarning(this.adv.data.sent_at, sentAt, createdAt);
    }

    hasClockWarning() {
        return this.getClockWarning() !== null;
    }

    getAdvertisementIntervalSeconds() {
        if (this.isExpired() || this.isVeryExpired()) return null;

        const intervalSeconds = this.adv?.data?.interval_seconds ?? null;
        if (intervalSeconds === null || intervalSeconds === undefined) return null;
        return Number(intervalSeconds);
    }

    getInlineAdvertisementIntervalText() {
        const intervalSeconds = this.getAdvertisementIntervalSeconds();
        if (intervalSeconds === null || !Number.isFinite(intervalSeconds)) return '';

        let roundedMinutes = Math.round(intervalSeconds / 60);
        if (roundedMinutes >= 60 * 3) {
            roundedMinutes = Math.ceil(roundedMinutes / 10) * 10;
        }
        const intervalText = formatAdvertInterval(intervalSeconds);
        if (roundedMinutes < 60 * 12) {
            return `<small class="contact-interval-text contact-interval-critical">${intervalText}</small>`;
        }
        if (roundedMinutes < 60 * 24) {
            return `<small class="contact-interval-text contact-interval-warning">${intervalText}</small>`;
        }
        return `<small class="contact-interval-text">${intervalText}</small>`;
    }

    updateDom() {
        if (!this.dom) return;
        if (!this.adv) return;

        let hashstr = this.hash;

        this.dom.container.dataset.type = this.adv.data.type;
        this.dom.container.dataset.contactId = this.data.id;
        this.dom.container.dataset.time = this.last.time;
        this.dom.container.dataset.name = this.__removeEmojis(this.adv.data.name).trim();
        this.dom.container.dataset.hash = hashstr;
        this.dom.container.dataset.pubkey = this.data.public_key;
        this.dom.container.dataset.multibyte = this.data.multibyte;
        this.dom.container.dataset.clock = this.hasClockWarning() ? 'bad' : 'ok';
        this.dom.container.dataset.first_seen = new Date(this.data.created_at).getTime();
        const advertIntervalSeconds = this.getAdvertisementIntervalSeconds();
        this.dom.container.dataset.advert_interval =
            advertIntervalSeconds !== null && Number.isFinite(advertIntervalSeconds)
                ? advertIntervalSeconds
                : '';

        this.dom.details.hidden = !this.expanded;

        if (this.isVeryExpired()) { // 3 days
            this.dom.contactDate.classList.add("prio-6");
        } else if (this.isExpired()) { // 3 days
            this.dom.contactDate.classList.add("prio-5");
        } else {
            this.dom.contactDate.classList.remove("prio-5");
            this.dom.contactDate.classList.remove("prio-6");
        }

        if (this.flags.dupe) {
            this.dom.contactHash.classList.add("prio-5");
        } if (this.isRepeater()) {
            this.dom.contactHash.classList.add("prio-4");
        } else {
            this.dom.contactHash.classList.remove("prio-4");
            this.dom.contactHash.classList.remove("prio-5");
        }

        let prefixWarnings = [];
        let clockWarning = this.getClockWarning();

        if (clockWarning && this._meshlog.shouldShowContactTimeWarnings()) {
            prefixWarnings.push(clockWarning);
        }

        if (this.isRepeater() && !this.hasLocation() && this._meshlog.shouldShowContactLocationWarnings()) {
            prefixWarnings.push({
                icon: "‼️",
                text: "Repeater has no location."
            });
        }

        if (prefixWarnings.length > 0) {
            this.dom.contactPrefix.textContent = prefixWarnings.map(w => w.icon).join("");
            this.dom.contactPrefix.classList.add('warn-icon')
            createTooltip(this.dom.contactPrefix, prefixWarnings.map(w => w.text).join(" | "));
        } else {
            this.dom.contactPrefix.innerHTML = "";
            this.dom.contactPrefix.classList.remove('warn-icon');
        }

        if (this.data.multibyte) {
            this.dom.contactName.classList.add('t-mb');
        }

        let type = '';
        if (this.isClient()) {
            this.dom.contactIcon.src = "assets/img/person.svg";
            type = 'Chat';
        } else if (this.isRepeater()) {
            this.dom.contactIcon.src = "assets/img/tower.svg";
            type = 'Repeater';
        } else if (this.isRoom()) {
            this.dom.contactIcon.src = "assets/img/group.svg";
            type = 'Room';
        }  else if (this.isSensor()) {
            this.dom.contactIcon.src = "assets/img/sensor.svg";
            type = 'Sensor';
        } else {
            this.dom.contactIcon.src = "assets/img/unknown.svg";
        }

        this.dom.detailsType.innerHTML = `<span class="detail-name">Type:</span> <span class="detail-value">${type}</span>`;
        this.dom.detailsFirst.innerHTML = `<span class="detail-name">First Seen:</span> <span class="detail-value">${this.data.created_at}</span>`;
        const advertInterval = this.getAdvertisementIntervalSeconds();
        if (advertInterval !== null && Number.isFinite(advertInterval)) {
            this.dom.detailsInterval.innerHTML = `<span class="detail-name">Advert Interval:</span> <span class="detail-value">${formatAdvertInterval(advertInterval)}</span>`;
        } else {
            this.dom.detailsInterval.innerHTML = '';
        }
        this.dom.detailsKey.innerHTML = `<span class="detail-name">Public Key:</span> <span class="detail-value">${this.data.public_key}</span>`;

        this.dom.contactName.innerText = this.adv.data.name;
        this.dom.contactDate.innerText = this.last.data.created_at;
        this.dom.contactHash.innerText = `[${hashstr}]`;

        let inlineMeta = [];
        if (this.telemetry && this._meshlog.shouldShowContactTelemetry()) {
            let channels = {};
            for (let i=0;i<this.telemetry.length;i++) {
                const sensor = this.telemetry[i];

                if (!channels.hasOwnProperty(sensor.channel)) {
                    channels[sensor.channel] = {};
                }

                if (!channels[sensor.channel].hasOwnProperty(sensor.name)) {
                    channels[sensor.channel][sensor.name] = [];
                }

                channels[sensor.channel][sensor.name].push(sensor.value);
            }

            // build detail text
            let detail = [];
            let short = '';

            const addMeasurement = (src, dst, key, scale, precision, unit) => {
                if (!src.hasOwnProperty(key)) return;
                if (src[key].size < 1) return;

                let val = (src[key][0] / scale).toFixed(precision);
                let str = `${val}`;
                if (unit) str += ` ${unit}`;
                dst.push(str);
            }

            Object.entries(channels).forEach(([ch,data]) => {
                let meas = [];

                addMeasurement(data, meas, "voltage", 1, 2, "V");
                addMeasurement(data, meas, "current", 1, 3, "mA");
                addMeasurement(data, meas, "temperature", 1, 2,  "°C");
                addMeasurement(data, meas, "humidity", 2, 1, " %");
                addMeasurement(data, meas, "pressure", 1, 1, " hPa");

                if (data.hasOwnProperty("voltage")) {
                    short = `${data["voltage"][0].toFixed(2)} V`;
                }

                detail.push(meas);
            });

            const result = detail
                .filter(arr => arr.length > 0) // remove empty arrays
                .map((arr, i) => `Ch${i + 1}: ${arr.join(', ')}`) // format each remaining array
                .join('<br>'); // join lines

            if (result.length > 0) {
                this.dom.detailsTelemetry.innerHTML = `<span class="detail-name">Telemetry:</span> <span class="detail-value">${result}</span>`;
                if (short) {
                    inlineMeta.push(short);
                }

            } else {
                this.dom.detailsTelemetry.innerHTML = '';
            }
        } else {
            this.dom.detailsTelemetry.innerHTML = '';
        }

        if (this._meshlog.shouldShowContactAdvertIntervalInline()) {
            const intervalText = this.getInlineAdvertisementIntervalText();
            if (intervalText) {
                inlineMeta.push(intervalText);
            }
        }

        this.dom.contactTelemetry.innerHTML = inlineMeta.join(' | ');

        if (this.marker) {
            this.updateTooltip();
        }

        if (this.highlight) {
            this.dom.contactName.classList.add("chighlight");
        } else {
            this.dom.contactName.classList.remove("chighlight");
        }

    }

    updateMarker() {
        if (!this.marker) return;
        this.updateMarkerIcon();

        if (this.marker.setLatLng) {
            this.marker.setLatLng([this.adv.data.lat, this.adv.data.lon]);
        }
    }

    update() {
        this.updateDom();
        this.updateMarker();
    }

    hasLocation() {
        if (!this.adv) return false;
        return !(Number(this.adv.data.lat) === 0 && Number(this.adv.data.lon) === 0);
    }

    isClient() {
        return this.adv && this.adv.data.type == 1;
    }

    isRepeater() {
        return this.adv && this.adv.data.type == 2;
    }

    isRoom() {
        return this.adv && this.adv.data.type == 3;
    }

    isSensor() {
        return this.adv && this.adv.data.type == 4;
    }

    isReporter() {
        return this._meshlog.isReporter(this.data.public_key);
    }

    pathTag() { return 'c'; }

    checkHash(hash) {
        let chash = this.data.public_key.substr(0, hash.length);
        return chash.toUpperCase() === hash.toUpperCase();
    }

    isExpired() {
        if (!this.last) return true;

        let age = new Date().getTime() - this.last.time;
        return age > (3 * 24 * 60 * 60 * 1000); // 3 days
    }

    isVeryExpired() {
        if (!this.last) return true;

        let age = new Date().getTime() - this.last.time;
        return age > (7 * 24 * 60 * 60 * 1000); // 7 days
    }
}

class MeshLogReport {
    constructor(meshlog, data, contact_id, parent) {
        this._meshlog = meshlog;
        this.data = data;
        this.dom = null;
        this.contact_id = contact_id;
        this.polyline = [];
        this.parent = parent;
    }

    showPath() {
        if (!this.isEnabled()) return;
        let sender = this._meshlog.contacts[this.contact_id] ?? false;
        let receiver = this._meshlog.reporters[this.data.reporter_id];
        if (!receiver) return;
        this._meshlog.showPath(this.data.id, this.data.path, sender, receiver);
    }

    hidePath() {
        this._meshlog.hidePath(this.data.id);
    }

    isEnabled() {
        let reporter = this._meshlog.reporters[this.data.reporter_id] ?? false;
        return reporter ? reporter.isEnabled() : false;
    }

    createDom(recreate = false) {
        if (this.dom && !recreate) return this.dom;

        if (this.dom && this.dom.container && this.dom.container.parentNode) {
            this.dom.container.parentNode.removeChild(this.dom.container);
            this.dom = null;
        }

        let reporter = this._meshlog.reporters[this.data.reporter_id] ?? false;
        if (!reporter) return null;
        if (!reporter.isEnabled()) return null;

        let divReport = document.createElement("div");
        let spDate = document.createElement("span");
        let spDot = document.createElement("span");
        let spPath = document.createElement("span");
        let spSnr = document.createElement("span");

        divReport.classList.add('log-entry');
        divReport.instance = this;
        spDate.classList.add(...['sp', 'cc']);
        spDot.classList.add(...['dot']);
        spPath.classList.add(...['sp']);
        spSnr.classList.add(...['sp']);

        let textColor = reporter.getStyle().color;
        let strokeColor = reporter.getStyle().stroke ?? textColor;
        let strokeWeight = reporter.getStyle().weight ?? '1px';
        spDot.innerText = reporter.data.name;
        spDot.style.color = textColor;
        spDot.style.border = `solid ${strokeWeight} ${strokeColor}`;

        spDate.innerText = this.data['created_at'].split(' ').pop();
        spPath.innerText = this.data['path'] || "direct";
        spSnr.innerText = this.data['snr'];

        divReport.append(spDate);
        divReport.append(spDot);
        divReport.append(spPath);
        // divReport.append(spSnr);

        this.dom = {
            container: divReport
        }

        return this.dom;
    }

    static onmouseover(e) {
        this.showPath();
        this._meshlog.updatePaths();
    }

    static onmouseout(e) {
        if (this.parent.dom.input.show.checked) return;
        this.hidePath();
        this._meshlog.updatePaths();
    }

    static oncontextmenu(e) {
        e.preventDefault();

        this._meshlog.dom_contextmenu
        const menu = this._meshlog.dom_contextmenu;

        while (menu.hasChildNodes()) {
            menu.removeChild(menu.lastChild);
        }

        // get paths

        let trk = '';
        let wpt = '';
        Object.entries(this._meshlog.layer_descs).forEach(([k,d]) => {
            for (const p of d.paths) {
                if (!trk) trk += `<trkpt lat="${p.from.lat}" lon="${p.from.lon}"></trkpt>\n`;
                trk += `<trkpt lat="${p.to.lat}" lon="${p.to.lon}"></trkpt>\n`;
            }

            for (const m of d.markers) {
                let c = this._meshlog.contacts[m];
                if (c && c.adv) {
                    wpt += `<wpt lat="${c.adv.data.lat}" lon="${c.adv.data.lon}"><name>${escapeXml(c.data.name)}</name></wpt>\n`;
                }
            }
        });

        trk = `<trk><trkseg>\n${trk}</trkseg></trk>`;

        let miGpx = document.createElement("div");
        miGpx.classList.add('menu-item');
        miGpx.innerText = "Export to GPX";
        miGpx.onclick = (e) => {
            let gpxContent = `<?xml version="1.0" encoding="UTF-8"?>\n`;
            gpxContent += `<gpx version="1.1" creator="Meshlog">\n`;

            gpxContent += wpt;
            gpxContent += trk;
            gpxContent += `</gpx>`;

            const blob = new Blob([gpxContent], { type: "application/gpx+xml" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "location.gpx";
            a.click();
        };

        menu.appendChild(miGpx);

        menu.style.display = 'block';
        menu.style.left = `${e.pageX}px`;
        menu.style.top = `${e.pageY}px`;
    }
}

class MeshLogReportedObject extends MeshLogObject {
    constructor(meshlog, data) {
        const objectData = { ...data };
        const reports = Array.isArray(objectData.reports) ? objectData.reports : [];
        delete objectData.reports;

        super(meshlog, objectData);
        this.dom = null;
        this.expanded = false;
        this.time = new Date(objectData.created_at).getTime();
        this.reports = [];

        for (let i=0; i<reports.length; i++) {
            let report = reports[i];
            this.reports.push(new MeshLogReport(meshlog, report, objectData.contact_id, this));
        }
    }

    merge(data) {
        const objectData = { ...data };
        const reports = Array.isArray(objectData.reports) ? objectData.reports : null;
        delete objectData.reports;

        super.merge(objectData);

        if (reports !== null) {
            this.reports = reports.map(report => new MeshLogReport(this._meshlog, report, objectData.contact_id, this));
        }
    }

    getVisibleReports() {
        return this.reports.filter(report => report.isEnabled());
    }

    hasVisibleReports() {
        return this.getVisibleReports().length > 0;
    }

    isSenderVisible() {
        return this._meshlog.isMessageSenderVisible(this.data.contact_id, this.data.name);
    }

    // Override!
    getId()   { return `?_${this.data.id}`; }
    getDate() { return {text: "Not Implemented", classList: []}; } // date - 2025-10-10 10:00:00
    getTag()  { return {text: "Not Implemented", classList: []}; } // tag  - [PUBLIC] 
    getName() { return {text: "Not Implemented", classList: []}; } // name - Anrijs
    getText() { return {text: "Not Implemented", classList: []}; } // text - Hello mesh!
    isVisible() { return false; }

    getPathTag() { return "unk"; }

    createDom(recreate = false) {
        if (this.dom && !recreate) return this.dom;

        if (this.dom && this.dom.container && this.dom.container.parentNode) {
            this.dom.container.parentNode.removeChild(this.dom.container);
            this.dom = null;
        }

        // Containers
        let divContainer = document.createElement("div");
        let divLog = document.createElement("div");
        let divReports = document.createElement("div");
        divContainer.dataset.time = this.time;
        divContainer.dataset.type = this.data.type;

        divLog.classList = 'log-entry';
        divLog.instance = this;
        divReports.classList = 'log-entry-reports';
        divReports.hidden = true;

        divContainer.append(divLog);
        divContainer.append(divReports);

        // Lines
        let divLine1 = document.createElement("div");
        let divLine2 = document.createElement("div");
        divLine1.classList.add('log-entry-info');
        divLine2.classList.add('log-entry-msg');
        divLog.append(divLine1);
        divLog.append(divLine2);

        // Text values
        let spDate = document.createElement("span");
        let spTag = document.createElement("span");
        let spPrefix = document.createElement("span");
        let spName = document.createElement("span");
        let spText = document.createElement("span");
        let spRight = document.createElement("span");

        let date = this.getDate();
        let tag = this.getTag();
        let name = this.getName();
        let text = this.getText();

        spDate.classList.add(...['sp', 'c']);
        spDate.classList.add(...date.classList);
        spDate.innerText = date.text;

        spTag.classList.add(...['sp', 'tag']);
        spTag.classList.add(...tag.classList);
        spTag.innerText = tag.text;

        // Check message times
        let sentAt = new Date(this.data.sent_at).getTime();
        let createdAt = new Date(this.data.created_at).getTime();
        let clockWarning = getClockOutOfSyncWarning(this.data.sent_at, sentAt, createdAt);
        if (clockWarning) {
            spPrefix.textContent = clockWarning.icon;
            spPrefix.classList.add('warn-icon')
            createTooltip(spPrefix, clockWarning.text);
        }

        spName.classList.add(...['sp', 't']);
        spName.classList.add(...name.classList);
        spName.innerText = name.text;
        spName.style.background = name.background ?? '';

        spText.classList.add(...['sp']);
        spText.classList.add(...text.classList);
        spText.innerHTML = text.text.linkify();
        spRight.classList.add('message-inline-meta');

        if (this.data.hash_size > 1) {
            spName.classList.add('t-mb');
            spTag.classList.add('t-mb');
        }

        if (text.text) {
            // message
            divLine1.append(spDate);
            divLine1.append(spTag);
            divLine2.append(spName);
            divLine2.append(spText);
        } else {
            // advert
            divLine1.append(spDate);
            // divLine1.append(spTag);
            divLine1.append(spName);
        }

        // Right
        let inputShow = document.createElement("input");
        inputShow.type = "checkbox";
        inputShow.classList.add(...['log-entry-cehckbox']);
        spRight.appendChild(spPrefix);
        spRight.appendChild(inputShow);
        divLine1.appendChild(spRight);

        inputShow.onclick = (e) => {
            e.stopPropagation();
        }

        this.dom = {
            container: divContainer,
            log: divLog,
            reports: divReports,
            input: {
                show: inputShow
            }
        };

        return this.dom;
    }

    updateDom() {
        if (this.highlight) {
            this.dom.log.classList.add("highlight");
        } else {
            this.dom.log.classList.remove("highlight");
        }

        this.dom.container.hidden = !this.isVisible();
        this.dom.reports.hidden = !this.expanded;
        const visibleReports = this.getVisibleReports();

        while (this.dom.reports.firstChild) {
            this.dom.reports.removeChild(this.dom.reports.firstChild);
        }

        if (this.expanded) {
            for (let i=0; i<visibleReports.length; i++) {
                let report = visibleReports[i];
                let dom = report.createDom(false);
                if (dom) {
                    this.dom.reports.append(dom.container);
                }
            }
        }
    }

    isAdvertisement() { return this instanceof MeshLogAdvertisement; }
    isChannelMessage() { return this instanceof ChannelMessage; }
    isDirectMessage() { return this instanceof DirectMessage; }

    static onclick(e) {
        this.expanded = !this.expanded;
        this.updateDom();
    }

    static onmouseover(e) {
        // show paths
        const visibleReports = this.getVisibleReports();
        for (let i=0;i<visibleReports.length;i++) {
            visibleReports[i].showPath();
        }
        this._meshlog.updatePaths();
    }

    static onmouseout(e) {
        // hide path
        if (this.dom.input.show.checked) return;
        const visibleReports = this.getVisibleReports();
        for (let i=0;i<visibleReports.length;i++) {
            visibleReports[i].hidePath();
        }
        this._meshlog.updatePaths();
    }
}

class MeshLogAdvertisement extends MeshLogReportedObject {
    static idPrefix = "a";
    getId()   { return `a_${this.data.id}`; }
    getDate() { return {text: this.data.created_at, classList: []}; }
    getTag()  { return {text: "ADVERT", classList: []}; }
    getName() { return {text: this.data.name, classList: []}; }
    getText() { return {text: "", classList: []}; }
    getPathTag() { return "ADV"; }
    isVisible() { return Settings.getBool('messageTypes.advertisements', true) && this.hasVisibleReports() && this.isSenderVisible(); }
}

class MeshLogChannelMessage extends MeshLogReportedObject {
    static idPrefix = "c";
    getTag()  {
        let chid = this.data.channel_id;
        let ch = this._meshlog.channels[chid] ?? false;
        let chname = ch ? ch.data.name : `Channel ${chid}`;
        return {text: `→ ${chname}`, classList: []};
    }

    getId()   { return `c_${this.data.id}`; }
    getDate() { return {text: this.data.created_at, classList: []}; }
    getName() { return {text: `${this.data.name}`, classList: ['t-bright'], background: str2color(this.data.name)}; }
    getText() { return {text: this.data.message, classList: ['t-white']}; }
    getPathTag() { return "MSG"; }
    isVisible() {
        let chid = this.data.channel_id;
        let ch = this._meshlog.channels[chid] ?? false;
        if (ch) ch = ch.isEnabled();
        return Settings.getBool('messageTypes.channel', true) && ch && this.hasVisibleReports() && this.isSenderVisible();
    }
}

class MeshLogDirectMessage extends MeshLogReportedObject {
    static idPrefix = "d";
    getTag()  {
        let text = '→ unknown';
        let reports = this.getVisibleReports();
        if (reports.length > 0) {
            let repid = reports[0].data.reporter_id;
            let reporter = this._meshlog.reporters[repid] ?? false;
            if (reporter) {
                text = `→ ${reporter.data.name}`;
            }
        }
        return {text: text, classList: []};
    }

    getId()   { return `d_${this.data.id}`; }
    getDate() { return {text: this.data.created_at, classList: []}; }
    getName() { return {text: `${this.data.name}`, classList: ['t-bright'], background: str2color(this.data.name) }; }
    getText() { return {text: this.data.message, classList: ['t-white']}; }
    getPathTag() { return "DIR"; }
    isVisible() { return Settings.getBool('messageTypes.direct', false) && this.hasVisibleReports() && this.isSenderVisible(); }
}

class MeshLogLinkLayer {
    constructor(from, to, reporter, circle, dashed = false) {
        this.from = from;
        this.to = to;
        this.reporter = reporter;
        this.circle = circle;
        this.dashed = dashed;
    }
}


class MeshLog {
    constructor(map, logsid, contactsid, stypesid, sreporterfilterid, sreportersid, scontactsid, warningid, errorid, contextmenuid) {
        this.reporters = {};
        this.contacts = {};
        this.channels = {};

        this.messages = {};

        this.map = map;
        this.layer_descs = {};
        this.link_layers = L.layerGroup([]);
        this.visible_markers = new Set();
        this.visible_contacts = {};
        this.links = {};
        this.canvas_renderer = L.canvas({ padding: 0.5 });
        this.dom_logs = document.getElementById(logsid);
        this.dom_contacts = document.getElementById(contactsid);
        this.dom_logs_filter_warning = document.getElementById("logs-filter-warning");
        this.dom_contacts_filter_warning = document.getElementById("contacts-filter-warning");
        this.dom_warning = document.getElementById(warningid);
        this.dom_error = document.getElementById(errorid);
        this.dom_contextmenu = document.getElementById(contextmenuid);
        this.timer = false;
        this.interval = 0;
        this.decor = true;
        this.default_api_count = 500;
        this.default_contacts_count = 2000;
        this.initial_messages_count = 250;
        this.older_messages_page_size = 200;
        this.loading_old = false;
        this.has_more_old = true;

        // epochs of newest loaded data
        this.latest = 0;
        this.latest_meta = 0;
        this.message_type_loaded = {
            advertisements: false,
            channel_messages: false,
            direct_messages: false,
        };
        this.message_type_loading = {
            advertisements: false,
            channel_messages: false,
            direct_messages: false,
        };
        this.window_active = true;
        this.new_messages = {};

        const self = this;

        window.onfocus = function () {
            self.window_active = true;
            self.clearNotifications();
        };

         
         window.onblur = function () {
            self.window_active = false;
         };
         

        this.dom_settings_types = document.getElementById(stypesid);
        this.dom_settings_reporter_filter = document.getElementById(sreporterfilterid);
        this.dom_settings_reporters = document.getElementById(sreportersid);
        this.dom_settings_contacts = document.getElementById(scontactsid);

        this.dom_contacts.addEventListener('click', this.handleMouseEvent);
        this.dom_contacts.addEventListener('mouseover', this.handleMouseEvent);
        this.dom_contacts.addEventListener('mouseout', this.handleMouseEvent);
        this.dom_contacts.addEventListener("contextmenu", this.handleMouseEvent);

        this.dom_logs.addEventListener('click', this.handleMouseEvent);
        this.dom_logs.addEventListener('mouseover', this.handleMouseEvent);
        this.dom_logs.addEventListener('mouseout', this.handleMouseEvent);
        this.dom_logs.addEventListener("contextmenu", this.handleMouseEvent);
        this.dom_logs.addEventListener('scroll', () => this.onLogsScroll());

        this.dom_warning.dataset.compact = "1";

        const menu = this.dom_contextmenu;
        document.addEventListener('click', function () {
            menu.style.display = 'none'; // Hide when clicking anywhere
        });

        this.__init_message_types();
        this.__init_reporter_filter();
        this.__init_filter_warnings();
        this.__init_contact_settings();
        this.__init_contact_order();
        this.__init_contact_types();
        this.__init_warnings();

        this.link_layers.addTo(this.map);

        this.last = '2025-01-01 00:00:00';
        this.marker_zoom_mode = this.getMapMarkerZoomMode();

        this.map.on("zoomend", () => {
            const nextMarkerMode = this.getMapMarkerZoomMode();
            if (nextMarkerMode !== this.marker_zoom_mode) {
                this.marker_zoom_mode = nextMarkerMode;
                Object.values(this.contacts).forEach(contact => contact.updateMarker());
            }
            this.link_layers.eachLayer((layer) => {
                if (!layer.checkVisibility) return;
                layer.checkVisibility();
            });
        });
    }

    handleMouseEvent(e) {
        const el = e.target.closest('.log-entry');
        if (!el) return;

        const from = e.relatedTarget;
        const related = (from && el.contains(from));

        const instance = el.instance;
        if (!instance) return;

        const cls = instance.constructor;

        switch (e.type) {
            case 'click':
                if (cls.onclick) cls.onclick.call(instance, e);
                break;
            case 'mouseover':
                if (!related && cls.onmouseover) cls.onmouseover.call(instance, e);
                break;
            case 'mouseout':
                if (!related && cls.onmouseout) cls.onmouseout.call(instance, e);
                break;
            case 'contextmenu':
                if (cls.oncontextmenu) cls.oncontextmenu.call(instance, e);
                break;
        }
    };

    getMapMarkerZoomMode() {
        return this.map && this.map.getZoom() < 11 ? 'point' : 'full';
    }

    __createCb(label, img, key, def, onchange) {
        let div = document.createElement("div");
        let cb = document.createElement("input");
        let lbl = document.createElement("label");
        let ico = document.createElement("img");

        cb.type = "checkbox";
        cb.dataset.settingKey = key;
        cb.checked = Settings.getBool(key, def);
        console.log('create cb: ', key, cb.checked);
        cb.onchange = (e) => {
            Settings.set(key, e.target.checked);
            localStorage[key] = e.target.checked;
            onchange(e);
        };

        lbl.innerText = label;

        if (img) {
            ico.src = img;
            ico.classList.add('icon-16');
            lbl.prepend(ico);
        }

        lbl.insertBefore(cb, lbl.firstChild);

        div.classList.add("settings-cb");
        div.appendChild(lbl);

        return div;
    }

    __createInput(name, key, def, onchange) {
        let div = document.createElement("div");
        let inp = document.createElement("input");

        inp.type = "text";
        inp.dataset.settingKey = key;
        inp.value = localStorage[key] ?? def;
        inp.oninput = (e) => {
            localStorage[key] = e.target.value;
            onchange(e);
        };
        inp.placeholder = name;

        div.classList.add("settings-input");
        div.appendChild(inp);

        return div;
    }

    __createNumberInput(label, key, def, onchange, options = {}) {
        let div = document.createElement("div");
        let lbl = document.createElement("span");
        let inp = document.createElement("input");

        lbl.classList.add("reporter-filter-limit-label");
        lbl.innerText = label;

        inp.type = "number";
        inp.dataset.settingKey = key;
        inp.value = Settings.get(key, def);
        if (options.min !== undefined) {
            inp.min = String(options.min);
        }
        if (options.step !== undefined) {
            inp.step = String(options.step);
        }
        if (options.placeholder) {
            inp.placeholder = options.placeholder;
        }
        inp.onchange = (e) => {
            Settings.set(key, e.target.value);
            onchange(e);
        };

        div.classList.add("reporter-filter-limit");
        div.appendChild(lbl);
        div.appendChild(inp);

        return div;
    }

    getContactSpecialFilterOptions() {
        return [
            { value: '{multibyte}', label: 'Multibyte Contacts' },
            { value: '{singlebyte}', label: 'Single-byte Contacts' },
            { value: '{clockbad}', label: 'Clock Out Of Sync' },
            { value: '{clockok}', label: 'Clock In Sync' },
        ];
    }

    isSpecialContactFilter(filter) {
        return this.getContactSpecialFilterOptions().some(option => option.value === filter);
    }

    matchesContactSpecialFilter(contact, filter) {
        if (!contact) return false;

        switch (filter) {
            case '{multibyte}':
                return String(contact.data.multibyte ?? '0') === '1';
            case '{singlebyte}':
                return String(contact.data.multibyte ?? '0') !== '1';
            case '{clockbad}':
                return contact.hasClockWarning && contact.hasClockWarning();
            case '{clockok}':
                return !(contact.hasClockWarning && contact.hasClockWarning());
            default:
                return false;
        }
    }

    __createContactFilterInput(onchange) {
        let div = document.createElement("div");
        let inp = document.createElement("input");
        let select = document.createElement("select");
        const key = 'contactFilter.value';

        const syncSelect = () => {
            const filter = String(inp.value ?? '').trim().toLowerCase();
            select.value = this.isSpecialContactFilter(filter) ? filter : '';
        };

        inp.type = "text";
        inp.dataset.settingKey = key;
        inp.value = Settings.get(key, '');
        inp.placeholder = "Filter by Name or Hash/Key";
        inp.oninput = (e) => {
            Settings.set(key, e.target.value);
            syncSelect();
            onchange(e);
        };

        select.dataset.settingKey = key;
        select.classList.add("settings-input-select");

        let placeholder = document.createElement("option");
        placeholder.value = '';
        placeholder.innerText = "User Query";
        select.appendChild(placeholder);

        for (const option of this.getContactSpecialFilterOptions()) {
            let node = document.createElement("option");
            node.value = option.value;
            node.innerText = option.label;
            select.appendChild(node);
        }

        select.onchange = (e) => {
            inp.readOnly = e.target.value ? true : false;

            inp.value = e.target.value;
            Settings.set(key, inp.value);
            syncSelect();
            onchange({ target: inp });
        };

        div.classList.add("settings-input", "settings-input-with-select");
        div.appendChild(inp);
        div.appendChild(select);

        syncSelect();
        return div;
    }

    getReportLimitSettingKey() {
        return 'reporters.reportLimit';
    }

    getAutorefreshSettingKey() {
        return 'messages.autorefreshSeconds';
    }

    getAutorefreshMinimumSeconds() {
        return 3;
    }

    getAutorefreshSetting() {
        const raw = Settings.get(this.getAutorefreshSettingKey(), 10);
        const parsed = parseInt(String(raw ?? '').trim(), 10);
        if (!Number.isFinite(parsed)) {
            return 10;
        }

        return Math.max(this.getAutorefreshMinimumSeconds(), parsed);
    }

    setAutorefreshSetting(value) {
        const parsed = parseInt(String(value ?? '').trim(), 10);
        const normalized = Number.isFinite(parsed)
            ? Math.max(this.getAutorefreshMinimumSeconds(), parsed)
            : 10;
        Settings.set(this.getAutorefreshSettingKey(), normalized);
        return normalized;
    }

    applyAutorefreshSetting() {
        const seconds = this.setAutorefreshSetting(this.getAutorefreshSetting());
        this.setAutorefresh(seconds * 1000);
        return seconds;
    }

    getContactTimeWarningsSettingKey() {
        return 'contacts.showTimeWarnings';
    }

    getContactLocationWarningsSettingKey() {
        return 'contacts.showLocationWarnings';
    }

    getContactAdvertIntervalInlineSettingKey() {
        return 'contacts.showAdvertIntervalInline';
    }

    getContactTelemetrySettingKey() {
        return 'contacts.showTelemetry';
    }

    shouldShowContactTimeWarnings() {
        return Settings.getBool(this.getContactTimeWarningsSettingKey(), true);
    }

    shouldShowContactLocationWarnings() {
        return Settings.getBool(this.getContactLocationWarningsSettingKey(), true);
    }

    shouldShowContactAdvertIntervalInline() {
        return Settings.getBool(this.getContactAdvertIntervalInlineSettingKey(), true);
    }

    shouldShowContactTelemetry() {
        return Settings.getBool(this.getContactTelemetrySettingKey(), false);
    }

    getReportLimitSetting() {
        const raw = Settings.get(this.getReportLimitSettingKey(), 1);
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    }

    setReportLimitSetting(value) {
        const parsed = parseInt(String(value ?? '').trim(), 10);
        const normalized = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        Settings.set(this.getReportLimitSettingKey(), normalized);
        return normalized;
    }

    __init_filter_warnings() {
        const buildWarning = (container, onclick) => {
            if (!container) return null;

            let text = document.createElement("span");
            let button = document.createElement("button");

            text.classList.add("filter-warning-text");
            button.classList.add("btn", "filter-warning-btn");
            button.type = "button";
            button.innerText = "Clear Filters";
            button.onclick = onclick;

            container.append(text);
            container.append(button);

            return { container, text, button };
        };

        this.filter_warnings = {
            logs: buildWarning(this.dom_logs_filter_warning, () => this.clearFilterWarnings()),
            contacts: buildWarning(this.dom_contacts_filter_warning, () => this.clearFilterWarnings()),
        };
    }

    __init_reporter_filter() {
        let summary = document.createElement("span");
        let button = document.createElement("button");
        let panel = document.createElement("div");

        summary.classList.add("reporter-filter-summary");
        button.classList.add("btn", "reporter-filter-toggle");
        button.type = "button";
        button.innerText = "Settings";
        panel.classList.add("reporter-filter-panel");
        panel.hidden = true;

        button.onclick = (e) => {
            e.stopPropagation();
            panel.hidden = !panel.hidden;
        };

        panel.onclick = (e) => {
            e.stopPropagation();
        };

        this.dom_settings_reporter_filter.onclick = (e) => {
            e.stopPropagation();
        };

        document.addEventListener("click", () => {
            panel.hidden = true;
        });

        this.dom_settings_reporter_filter.append(summary);
        this.dom_settings_reporter_filter.append(button);
        this.dom_settings_reporter_filter.append(panel);

        this.dom_reporter_filter = {
            summary,
            button,
            panel,
        };

        this.updateReporterFilterDom();
    }

    __init_contact_settings() {
        let header = document.createElement("div");
        let summary = document.createElement("span");
        let button = document.createElement("button");
        let panel = document.createElement("div");

        header.classList.add("contact-settings-header");
        summary.classList.add("reporter-filter-summary");
        summary.innerText = "Contact Settings";
        button.classList.add("btn", "reporter-filter-toggle");
        button.type = "button";
        button.innerText = "Settings";
        panel.classList.add("reporter-filter-panel");
        panel.hidden = true;

        button.onclick = (e) => {
            e.stopPropagation();
            panel.hidden = !panel.hidden;
        };

        panel.onclick = (e) => {
            e.stopPropagation();
        };

        this.dom_settings_contacts.onclick = (e) => {
            e.stopPropagation();
        };

        document.addEventListener("click", () => {
            panel.hidden = true;
        });

        header.append(summary);
        header.append(button);
        header.append(panel);
        this.dom_settings_contacts.append(header);

        this.dom_contact_settings = {
            header,
            summary,
            button,
            panel,
        };
    }

    getContactSettingsPanel() {
        return this.dom_contact_settings?.panel ?? this.dom_settings_contacts;
    }

    onContactDisplaySettingsChanged() {
        Object.values(this.contacts).forEach(contact => {
            contact.createDom(false);
            contact.updateDom();
        });
        this.updateContactsDom();
    }

    updateReporterFilterDom() {
        if (!this.dom_reporter_filter) return;

        const reporters = Object.values(this.reporters)
            .sort((a, b) => a.data.name.localeCompare(b.data.name));
        const enabled = reporters.filter(reporter => reporter.isEnabled()).length;
        const autorefreshSeconds = this.setAutorefreshSetting(
            Settings.get(this.getAutorefreshSettingKey(), 10)
        );

        this.dom_reporter_filter.summary.innerText = `Enabled reporters: ${enabled}/${reporters.length}`;

        while (this.dom_reporter_filter.panel.firstChild) {
            this.dom_reporter_filter.panel.removeChild(this.dom_reporter_filter.panel.firstChild);
        }

        this.dom_reporter_filter.panel.appendChild(
            this.__createNumberInput(
                "Autorefresh every (seconds)",
                this.getAutorefreshSettingKey(),
                autorefreshSeconds,
                (e) => {
                    const seconds = this.setAutorefreshSetting(e.target.value);
                    e.target.value = seconds;
                    this.setAutorefresh(seconds * 1000);
                },
                {
                    min: this.getAutorefreshMinimumSeconds(),
                    step: 1,
                }
            )
        );

        let limitContainer = document.createElement("div");
        let limitLabel = document.createElement("span");
        let limitInput = document.createElement("input");
        const currentLimit = this.getReportLimitSetting();

        limitContainer.classList.add("reporter-filter-limit");
        limitLabel.classList.add("reporter-filter-limit-label");
        limitLabel.innerText = "Max reports per object per reporter";
        limitInput.type = "text";
        limitInput.inputMode = "numeric";
        limitInput.value = currentLimit;
        limitInput.placeholder = "1";

        limitInput.onchange = () => {
            const previousLimit = this.getReportLimitSetting();
            const nextLimit = this.setReportLimitSetting(limitInput.value);
            limitInput.value = nextLimit;

            if (nextLimit !== previousLimit) {
                this.reloadAllData();
            }
        };

        limitInput.onkeydown = (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                limitInput.blur();
            }
        };

        limitContainer.append(limitLabel);
        limitContainer.append(limitInput);
        this.dom_reporter_filter.panel.append(limitContainer);

        let actionsContainer = document.createElement("div");
        let selectAllButton = document.createElement("button");
        let deselectAllButton = document.createElement("button");

        actionsContainer.classList.add("reporter-filter-actions");

        selectAllButton.type = "button";
        selectAllButton.classList.add("btn");
        selectAllButton.innerText = "Select All";
        selectAllButton.onclick = () => {
            this.setAllReporterFiltersState(true);
        };

        deselectAllButton.type = "button";
        deselectAllButton.classList.add("btn");
        deselectAllButton.innerText = "Deselect All";
        deselectAllButton.onclick = () => {
            this.setAllReporterFiltersState(false);
        };

        actionsContainer.append(selectAllButton);
        actionsContainer.append(deselectAllButton);
        this.dom_reporter_filter.panel.append(actionsContainer);

        for (const reporter of reporters) {
            const dom = reporter.createSettingsDom(false);
            reporter.updateSettingsDom();
            this.dom_reporter_filter.panel.append(dom.container);
        }
    }

    setAllReporterFiltersState(enabled) {
        for (const reporter of Object.values(this.reporters)) {
            Settings.set(reporter.getSettingsKey(), enabled);
        }

        this.onReporterFilterChanged();
    }

    clearReporterFiltersState() {
        this.setAllReporterFiltersState(true);
    }

    clearContactListFiltersState() {
        const keys = [
            'contactTypes.clients',
            'contactTypes.repeaters',
            'contactTypes.rooms',
            'contactTypes.sensors',
        ];

        for (const key of keys) {
            Settings.set(key, true);
        }
        Settings.set('contactFilter.value', '');
    }

    syncContactFilterControls() {
        const nodes = this.dom_settings_contacts.querySelectorAll('[data-setting-key]');

        for (const node of nodes) {
            const key = node.dataset.settingKey;
            if (!key) continue;

            if (node.type === "checkbox") {
                node.checked = Settings.getBool(key, true);
            } else if (node.type === "text") {
                node.value = Settings.get(key, '');
            } else if (node.tagName === "SELECT") {
                const value = String(Settings.get(key, '') ?? '').trim().toLowerCase();
                node.value = this.isSpecialContactFilter(value) ? value : '';
            }
        }
    }

    clearFilterWarnings() {
        this.clearReporterFiltersState();
        this.clearContactListFiltersState();
        this.syncContactFilterControls();
        this.updateReporterFilterDom();
        this.onReporterFilterChanged();
    }

    getVisibleContactIdsByReporter() {
        if (!this.hasActiveReporterFilter()) {
            return new Set(Object.values(this.contacts).map(contact => String(contact.data.id)));
        }

        const visible = new Set();
        const enabledReporterIds = new Set(
            Object.values(this.reporters)
                .filter(reporter => reporter.isEnabled())
                .map(reporter => String(reporter.data.id))
        );

        for (const reporter of Object.values(this.reporters)) {
            if (!reporter.isEnabled()) continue;

            const contactId = reporter.getContactId();
            if (contactId !== -1) {
                visible.add(String(contactId));
            }
        }

        for (const contact of Object.values(this.contacts)) {
            const reporterIds = Array.isArray(contact.data.reporter_ids)
                ? contact.data.reporter_ids.map(id => String(id))
                : [];

            if (reporterIds.length > 0) {
                if (reporterIds.some(id => enabledReporterIds.has(id))) {
                    visible.add(String(contact.data.id));
                }
                continue;
            }

            if (contact.adv?.hasVisibleReports && contact.adv.hasVisibleReports()) {
                visible.add(String(contact.data.id));
            }
        }

        for (const msg of Object.values(this.messages)) {
            if (!msg.hasVisibleReports || !msg.hasVisibleReports()) continue;
            if (msg.data.contact_id === undefined || msg.data.contact_id === null) continue;
            visible.add(String(msg.data.contact_id));
        }

        return visible;
    }

    refreshVisibleNeighborPaths() {
        const visibleContactIds = this.getVisibleContactIdsByReporter();
        const visibleNeighbors = Object.values(this.contacts)
            .filter(contact => contact.neighbors_visible);

        for (const contact of visibleNeighbors) {
            const prefix = contact.getLayerDescPrefix();
            Object.keys(this.layer_descs).forEach(key => {
                if (key.startsWith(prefix)) {
                    delete this.layer_descs[key];
                }
            });
            contact.neighbors_visible = false;
        }

        for (const contact of visibleNeighbors) {
            if (visibleContactIds.has(String(contact.data.id))) {
                contact.showNeighbors();
            }
        }
    }

    __onTypesChanged() {
        const typesToLoad = this.getEnabledMessageTypes().filter(type => {
            return !this.message_type_loaded[type] && !this.message_type_loading[type];
        });

        if (typesToLoad.length) {
            this.loadSelectedMessageTypes(
                {
                    count: this.initial_messages_count,
                },
                {
                    types: typesToLoad,
                }
            );
        }

        this.updateMessagesDom();
    }

    onReporterFilterChanged() {
        for (const msg of Object.values(this.messages)) {
            for (const report of msg.reports) {
                if (!report.isEnabled()) {
                    report.hidePath();
                }
            }
        }

        this.updateReporterFilterDom();
        this.updateMessagesDom();
        this.updateContactsDom();
        this.refreshVisibleNeighborPaths();
        this.updatePaths();
    }

    hasActiveReporterFilter() {
        const totalReporters = Object.keys(this.reporters).length;
        if (totalReporters < 1) return false;

        const enabledReporters = Object.values(this.reporters)
            .filter(reporter => reporter.isEnabled()).length;

        return enabledReporters !== totalReporters;
    }

    hasActiveContactListFilter() {
        if (!Settings.getBool('contactTypes.clients', true)) return true;
        if (!Settings.getBool('contactTypes.repeaters', true)) return true;
        if (!Settings.getBool('contactTypes.rooms', true)) return true;
        if (!Settings.getBool('contactTypes.sensors', true)) return true;
        if (Settings.get('contactFilter.value', '').trim().length > 0) return true;

        return false;
    }

    hasActiveContactFilter() {
        return this.hasActiveReporterFilter() || this.hasActiveContactListFilter();
    }

    hasActiveChannelFilter() {
        const channels = Object.values(this.channels);
        if (channels.length < 1) return false;
        return channels.some(channel => !channel.isEnabled());
    }

    hasActiveMessageFilter() {
        if (this.hasActiveReporterFilter()) return true;
        if (this.hasActiveContactListFilter()) return true;

        return false;
    }

    updateContactsFilterWarning() {
        if (!this.filter_warnings?.contacts) return;

        const active = this.hasActiveContactFilter();
        this.filter_warnings.contacts.container.hidden = !active;
        this.filter_warnings.contacts.text.innerText = active ? "Filters active: some contacts are hidden." : "";
    }

    updateMessagesFilterWarning() {
        if (!this.filter_warnings?.logs) return;

        const active = this.hasActiveMessageFilter();
        this.filter_warnings.logs.container.hidden = !active;
        this.filter_warnings.logs.text.innerText = active ? "Filters active: some messages are hidden." : "";
    }

    isContactVisible(contactId, senderName = "") {
        const filter = Settings.get('contactFilter.value', '').trim().toLowerCase();
        const sender = String(senderName ?? "").trim().toLowerCase();

        if (contactId === undefined || contactId === null) {
            if (filter && !this.isSpecialContactFilter(filter)) {
                return sender.includes(filter);
            }
            return !this.hasActiveContactFilter();
        }

        const contact = this.contacts[contactId] ?? false;
        if (!contact || !contact.dom?.container) {
            if (filter && !this.isSpecialContactFilter(filter)) {
                return sender.includes(filter);
            }
            return !this.hasActiveContactFilter();
        }

        return !contact.dom.container.hidden;
    }

    isMessageSenderVisible(contactId, senderName = "") {
        const filter = Settings.get('contactFilter.value', '').trim().toLowerCase();
        const sender = String(senderName ?? "").trim().toLowerCase();

        if (contactId === undefined || contactId === null) {
            if (filter && !this.isSpecialContactFilter(filter)) {
                return sender.includes(filter);
            }
            return !filter && !this.hasActiveContactListFilter();
        }

        const contact = this.contacts[contactId] ?? false;
        if (!contact) {
            if (filter && !this.isSpecialContactFilter(filter)) {
                return sender.includes(filter);
            }
            return !filter && !this.hasActiveContactListFilter();
        }

        let hidden = false;
        let type = parseInt(contact.adv?.data?.type ?? contact.dom?.container?.dataset.type ?? 0, 10);

        if (type == 1 && !Settings.getBool('contactTypes.clients', true)) { hidden = true; }
        else if (type == 2 && !Settings.getBool('contactTypes.repeaters', true)) { hidden = true; }
        else if (type == 3 && !Settings.getBool('contactTypes.rooms', true)) { hidden = true; }
        else if (type == 4 && !Settings.getBool('contactTypes.sensors', true)) { hidden = true; }

        if (!hidden && filter) {
            if (this.isSpecialContactFilter(filter)) {
                hidden = !this.matchesContactSpecialFilter(contact, filter);
            } else {
                const name = String(contact.dom?.container?.dataset.name ?? contact.adv?.data?.name ?? senderName ?? "").toLowerCase();
                const hash = String(contact.dom?.container?.dataset.hash ?? contact.hash ?? "").toLowerCase();
                const pubkey = String(contact.data.public_key ?? "").toLowerCase();

                let cmpName = name.includes(filter);
                let cmpHash = hash.startsWith(filter);
                let cmpPubkey = pubkey.startsWith(filter);
                hidden = !cmpName && !cmpHash && !cmpPubkey;
            }
        }

        return !hidden;
    }

    sortContacts(fn=undefined, reverse=false) {
        if (!fn) {
            fn = this.order.fn;
            reverse = this.order.reverse;
        }

        const items = Array.from(this.dom_contacts.children);
        const visibleContactIds = this.getVisibleContactIdsByReporter();
        items.sort(fn);
        if (reverse) items.reverse();
        items.forEach(item => {
            let type = parseInt(item.dataset.type);
            let hidden = false;;
            if (!visibleContactIds.has(item.dataset.contactId)) { hidden = true; }
            if (type == 1 && !Settings.getBool('contactTypes.clients', true)) { hidden = true; }
            else if (type == 2 && !Settings.getBool('contactTypes.repeaters', true)) { hidden = true; }
            else if (type == 3 && !Settings.getBool('contactTypes.rooms', true)) { hidden = true; }
            else if (type == 4 && !Settings.getBool('contactTypes.sensors', true)) { hidden = true; }

            if (!hidden) {
                let filter = Settings.get('contactFilter.value', '').trim().toLowerCase();
                if (filter) {
                    const contact = this.contacts[item.dataset.contactId] ?? false;

                    if (this.isSpecialContactFilter(filter)) {
                        hidden = !this.matchesContactSpecialFilter(contact, filter);
                    } else {
                        let cmpName = item.dataset.name.toLowerCase().includes(filter);
                        let cmpHash = item.dataset.hash.toLowerCase().startsWith(filter);
                        let cmpPubkey = item.dataset.pubkey.toLowerCase().startsWith(filter);
                        hidden = !cmpName && !cmpHash && !cmpPubkey;
                    }
                }
            }


            item.hidden = hidden;
            this.dom_contacts.appendChild(item)
        });
        this.fadeMarkers();
        this.updateContactsFilterWarning();
        this.updateMessagesDom();
    }

    __init_contact_order() {
        let orders = [
            {
                name: 'Last Heard',
                fn: (a, b) => { 
                    return (Number(b.dataset.time) - Number(a.dataset.time));
                }
            },
            {
                name: 'Hash',
                fn: (a, b) => { 
                    return parseInt(`0x${a.dataset.hash}`) - parseInt(`0x${b.dataset.hash}`);
                }
            },
            {
                name: 'Name',
                fn: (a, b) => { 
                    return a.dataset.name.localeCompare(b.dataset.name);
                },
            },
            {
                name: 'First Seen',
                fn: (a, b) => {
                    return b.dataset.first_seen.localeCompare(a.dataset.first_seen);
                },
            },
        ];

        this.order = {
            fn: orders[0].fn,
            reverse: false,
            buttons: []
        };

        let container = document.createElement('div');
        let text = document.createElement('span');
        container.append(text);

        const self = this;
        for (let i=0;i<orders.length;i++) {
            let btn = document.createElement('button');
            btn.classList.add('btn');
            btn.innerText = orders[i].name;

            if (i == 0) {
                btn.classList.add('active');
            }

            btn.onclick = (e) => {
                for (const b of self.order.buttons) {
                    b.classList.remove('active');
                    b.classList.remove('reverse');
                }

                btn.classList.add('active');

                if (self.order.fn == orders[i].fn) {
                    self.order.reverse = !self.order.reverse;
                    if (self.order.reverse) {
                        btn.classList.add('reverse');
                    }
                } else {
                    self.order.fn = orders[i].fn;
                    self.order.reverse = false;
                }
                self.sortContacts();
            }
            this.order.buttons.push(btn);
            container.appendChild(btn);
        }

        this.dom_settings_contacts.appendChild(container);
    }

    __init_contact_types() {
        const settingsPanel = this.getContactSettingsPanel();
        const self = this;
        settingsPanel.appendChild(
            this.__createCb(
                "Time warnings",
                "",
                this.getContactTimeWarningsSettingKey(),
                true,
                () => {
                    self.onContactDisplaySettingsChanged();
                }
            )
        );
        settingsPanel.appendChild(
            this.__createCb(
                "Location warnings",
                "",
                this.getContactLocationWarningsSettingKey(),
                true,
                () => {
                    self.onContactDisplaySettingsChanged();
                }
            )
        );
        settingsPanel.appendChild(
            this.__createCb(
                "Show advert interval",
                "",
                this.getContactAdvertIntervalInlineSettingKey(),
                true,
                () => {
                    self.onContactDisplaySettingsChanged();
                }
            )
        );
        settingsPanel.appendChild(
            this.__createCb(
                "Show telemetry",
                "",
                this.getContactTelemetrySettingKey(),
                false,
                () => {
                    self.onContactDisplaySettingsChanged();
                }
            )
        );
        this.dom_settings_contacts.appendChild(
            this.__createCb(
                "",
                "assets/img/tower.svg",
                'contactTypes.repeaters',
                true,
                (e) => {
                    self.sortContacts();
                }
            )
        );
        this.dom_settings_contacts.appendChild(
            this.__createCb(
                "",
                "assets/img/person.svg",
                'contactTypes.clients',
                true,
                (e) => {
                    self.sortContacts();
                }
            )
        );
        this.dom_settings_contacts.appendChild(
            this.__createCb(
                "",
                "assets/img/group.svg",
                'contactTypes.rooms',
                true,
                (e) => {
                    self.sortContacts();
                }
            )
        );
        this.dom_settings_contacts.appendChild(
            this.__createCb(
                "",
                "assets/img/sensor.svg",
                'contactTypes.sensors',
                true,
                (e) => {
                    self.sortContacts();
                }
            )
        );
        this.dom_settings_contacts.appendChild(
            this.__createContactFilterInput((e) => {
                self.sortContacts();
            })
        );
    }

    __init_message_types() {
        const self = this;
        this.dom_settings_types.appendChild(
            this.__createCb(
                "Advertisements",
                "assets/img/beacon.png",
                'messageTypes.advertisements',
                true,
                (e) => {
                    self.__onTypesChanged();
                }
            )
        );

        this.dom_settings_types.appendChild(
            this.__createCb(
                "Channel Messages",
                "assets/img/message.png",
                'messageTypes.channel',
                true,
                (e) => {
                    self.__onTypesChanged();
                }
            )
        );

        this.dom_settings_types.append(
            this.__createCb(
                "Direct Messages",
                "assets/img/message.png",
                'messageTypes.direct',
                false,
                (e) => {
                    self.__onTypesChanged();
                }
            )
        );

        this.dom_settings_types.append(
            this.__createCb(
                "🐐",
                "",
                'notifications.enabled',
                false,
                (e) => { }
            )
        );
    }

    __init_reporters() {
        Object.values(this.reporters).forEach(reporter => {
            reporter.createSettingsDom(false);
            reporter.updateSettingsDom();
        });
        this.updateReporterFilterDom();
    }

    __init_warnings() {
        this.dom_warning_messages = document.createElement("div");
        this.dom_warning_messages.classList.add("warnings");
        this.dom_warning_messages_btn = document.createElement("button");
        this.dom_warning_messages_btn.innerText = "Show more";
        this.dom_warning_messages_btn.classList.add("btn");
        this.dom_warning_messages_btn.onclick = (e) => {
            let str = "Show more";
            let com = "1";
            if (this.dom_warning.dataset.compact === com) {
                com = "0";
                str = "Show less";
            }
            this.dom_warning.dataset.compact = com;
            this.dom_warning_messages_btn.innerText = str;
            this.updatePaths();
        }

        this.dom_warning.append(this.dom_warning_messages);
        this.dom_warning.append(this.dom_warning_messages_btn);
    }

    __prepareQuery(params={}) {
        let query = {};
        // bax date
        if (params.hasOwnProperty('after_ms')) {
            query.after_ms = params['after_ms'];
        }
        // min date
        if (params.hasOwnProperty('before_ms')) {
            query.before_ms = params['before_ms'];
        }

        // max count
        if (params.hasOwnProperty('count')) {
            query.count = params['count'];
        }

        if (params.hasOwnProperty('messages_count')) {
            query.messages_count = params['messages_count'];
        }

        if (params.hasOwnProperty('contacts_count')) {
            query.contacts_count = params['contacts_count'];
        }

        if (params.hasOwnProperty('include_meta')) {
            query.include_meta = params['include_meta'];
        }

        if (params.hasOwnProperty('ids')) {
            query.ids = params['ids'];
        }

        if (params.hasOwnProperty('include_advertisements')) {
            query.include_advertisements = params['include_advertisements'];
        }

        if (params.hasOwnProperty('include_channel_messages')) {
            query.include_channel_messages = params['include_channel_messages'];
        }

        if (params.hasOwnProperty('include_direct_messages')) {
            query.include_direct_messages = params['include_direct_messages'];
        }

        // reporter ids
        if (params.hasOwnProperty('reporters')) {
            query.reporters = params['reporters'];
        }

        query.report_limit = this.getReportLimitSetting();

        return query;
    }

    __fetchQuery(params, url, onResponse) {
        const query = this.__prepareQuery(params);
        const urlparams = new URLSearchParams();

        for (const key in query) {
            if (query.hasOwnProperty(key)) {
                const value = query[key];
                if (Array.isArray(value)) {
                    value.forEach(item => urlparams.append(`${key}[]`, item));
                } else if (value !== undefined && value !== null) {
                    urlparams.append(key, value);
                }
            }
        }

        fetch(`${url}?${urlparams.toString()}`)
            .then(response => response.json())
            .then(data => onResponse(data));
    }

    __fetchQueryPromise(params, url) {
        return new Promise((resolve, reject) => {
            this.__fetchQuery(params, url, data => {
                if (data?.error) {
                    this.showError(data.error);
                    reject(new Error(data.error));
                    return;
                }

                resolve(data);
            });
        });
    }

    showWarning(msg) {
        this.dom_warning_messages.innerText = msg;
        if (msg.length > 0) {
            this.dom_warning.hidden = false;
        } else {
            this.dom_warning.hidden = true;
        }
    }

    showError(message, timeout=0) {
        this.setAutorefresh(0);
        this.dom_error.innerHTML = message;
        this.dom_error.classList.add('show');

        // Auto-hide after duration
        const self = this;
        if (timeout > 0) {
           setTimeout(() => {
                self.dom_error.classList.remove('show');
            }, timeout);
        }
    }

    __loadObjects(dataset, data, klass, options = {}) {
        if (data.error) {
            this.showError(data.error);
            return [];
        }

        const loaded = [];
        const objects = Array.isArray(data?.objects) ? data.objects : [];
        const trackLatest = options.trackLatest !== false;
        const latestTarget = options.latestTarget ?? 'message';

        for (let i=0;i<objects.length;i++) {
            const o = objects[i];
            const id = klass.idPrefix + o.id;
            if (dataset.hasOwnProperty(id)) {
                dataset[id].merge(o);
            } else {
                dataset[id] = new klass(this, o);
            }
            loaded.push(dataset[id]);

            if (trackLatest) {
                const latestValue = o.activity_at ?? o.created_at;
                let created_at = new Date(latestValue).getTime();
                if (created_at != 0) {
                    if (latestTarget === 'meta') {
                        if (created_at > this.latest_meta) {
                            this.latest_meta = created_at;
                        }
                    } else if (created_at > this.latest) {
                        this.latest = created_at;
                    }
                }
            }
        }

        return loaded;
    }

    __loadEndpoint(url, params, dataset, klass, options = {}) {
        return this.__fetchQueryPromise(params, url)
            .then(data => this.__loadObjects(dataset, data, klass, options));
    }

    getEnabledMessageTypes() {
        const enabled = [];

        if (Settings.getBool('messageTypes.advertisements', true)) {
            enabled.push('advertisements');
        }
        if (Settings.getBool('messageTypes.channel', true)) {
            enabled.push('channel_messages');
        }
        if (Settings.getBool('messageTypes.direct', false)) {
            enabled.push('direct_messages');
        }

        return enabled;
    }

    getMessageEndpoint(type) {
        switch (type) {
            case 'advertisements':
                return {
                    url: 'api/v1/advertisements',
                    klass: MeshLogAdvertisement,
                };
            case 'channel_messages':
                return {
                    url: 'api/v1/channel_messages',
                    klass: MeshLogChannelMessage,
                };
            case 'direct_messages':
                return {
                    url: 'api/v1/direct_messages',
                    klass: MeshLogDirectMessage,
                };
            default:
                return null;
        }
    }

    loadMeta(params = {}, options = {}) {
        const includeContacts = options.includeContacts !== false;
        const metaParams = {
            after_ms: params.after_ms ?? 0,
            before_ms: params.before_ms ?? 0,
        };
        const reporterParams = {
            ...metaParams,
            count: params.reporters_count ?? params.count ?? this.default_api_count,
        };
        const channelParams = {
            ...metaParams,
            count: params.channels_count ?? params.count ?? this.default_api_count,
        };
        const contactParams = {
            ...metaParams,
            count: params.contacts_count ?? this.default_contacts_count,
            telemetry: params.telemetry ?? params.include_telemetry ?? (this.shouldShowContactTelemetry() ? 1 : 0),
        };

        return Promise.all([
            this.__loadEndpoint('api/v1/reporters', reporterParams, this.reporters, MeshLogReporter, {
                latestTarget: 'meta',
            }),
            this.__loadEndpoint('api/v1/channels', channelParams, this.channels, MeshLogChannel, {
                latestTarget: 'meta',
            }),
        ]).then(([reporters, channels]) => {
            const contactsPromise = includeContacts
                ? this.__loadEndpoint('api/v1/contacts', contactParams, this.contacts, MeshLogContact, {
                    latestTarget: 'meta',
                })
                : Promise.resolve([]);

            return contactsPromise.then(contacts => {
                this.__init_reporters();
                this.onLoadChannels(channels);
                if (includeContacts) {
                    this.onLoadContacts(contacts);
                }

                return {
                    reporters,
                    channels,
                    contacts,
                };
            });
        });
    }

    loadMessageIds(params = {}, types = null) {
        const enabledTypes = types ?? this.getEnabledMessageTypes();
        const requestedTypes = new Set(enabledTypes);

        if (requestedTypes.size < 1) {
            return Promise.resolve({
                advertisements: [],
                channel_messages: [],
                direct_messages: [],
            });
        }

        return this.__fetchQueryPromise({
            count: params.count ?? this.initial_messages_count,
            after_ms: params.after_ms ?? 0,
            before_ms: params.before_ms ?? 0,
            include_advertisements: requestedTypes.has('advertisements') ? 1 : 0,
            include_channel_messages: requestedTypes.has('channel_messages') ? 1 : 0,
            include_direct_messages: requestedTypes.has('direct_messages') ? 1 : 0,
        }, 'api/v1/message_ids');
    }

    loadSelectedMessageTypes(params = {}, options = {}) {
        const types = Array.isArray(options.types) ? options.types : this.getEnabledMessageTypes();
        if (types.length < 1) {
            const empty = {
                advertisements: [],
                channel_messages: [],
                direct_messages: [],
            };
            if (options.onload) {
                options.onload(empty);
            }
            return Promise.resolve(empty);
        }

        types.forEach(type => {
            this.message_type_loading[type] = true;
        });

        return Promise.all(types.map(type => {
            const endpoint = this.getMessageEndpoint(type);
            if (!endpoint) {
                return Promise.resolve({ type, loaded: [] });
            }

            return this.__loadEndpoint(endpoint.url, {
                count: params.count ?? this.initial_messages_count,
                after_ms: params.after_ms ?? 0,
                before_ms: params.before_ms ?? 0,
            }, this.messages, endpoint.klass).then(loaded => ({ type, loaded }));
        }))
            .then(results => {
                const loadedByType = {
                    advertisements: [],
                    channel_messages: [],
                    direct_messages: [],
                };
                const loadedCounts = {
                    advertisements: 0,
                    channel_messages: 0,
                    direct_messages: 0,
                };

                results.forEach(result => {
                    loadedByType[result.type] = result.loaded;
                    loadedCounts[result.type] = result.loaded.length;
                    this.message_type_loaded[result.type] = true;
                    this.message_type_loading[result.type] = false;
                });

                this.onLoadMessages([
                    ...loadedByType.advertisements,
                    ...loadedByType.channel_messages,
                    ...loadedByType.direct_messages,
                ], {
                    appendOlder: options.appendOlder === true,
                });

                if (options.onload) {
                    options.onload(loadedByType, loadedCounts);
                }

                return loadedByType;
            })
            .catch(error => {
                types.forEach(type => {
                    this.message_type_loading[type] = false;
                });
                throw error;
            });
    }

    resetData() {
        Object.values(this.contacts).forEach(contact => {
            if (contact.marker) {
                this.map.removeLayer(contact.marker);
            }
        });

        this.link_layers.eachLayer(layer => {
            this.link_layers.removeLayer(layer);
        });

        this.reporters = {};
        this.contacts = {};
        this.channels = {};
        this.messages = {};
        this.layer_descs = {};
        this.visible_markers.clear();
        this.visible_contacts = {};
        this.links = {};
        this.latest = 0;
        this.latest_meta = 0;
        this.message_type_loaded = {
            advertisements: false,
            channel_messages: false,
            direct_messages: false,
        };
        this.message_type_loading = {
            advertisements: false,
            channel_messages: false,
            direct_messages: false,
        };

        this.dom_logs.replaceChildren();
        this.dom_contacts.replaceChildren();
        this.dom_settings_reporters.replaceChildren();

        this.showWarning('');
        this.clearNotifications();
        this.new_messages = {};
        this.updateReporterFilterDom();
    }

    reloadAllData() {
        const interval = this.interval ?? 0;
        this.setAutorefresh(0);
        this.resetData();
        this.loadInitial();
        this.setAutorefresh(interval);
    }

    getOldestMessageTime() {
        let oldest = 0;

        Object.values(this.messages).forEach(msg => {
            if (!oldest || msg.time < oldest) {
                oldest = msg.time;
            }
        });

        return oldest;
    }

    onLogsScroll() {
        if (this.loading_old || !this.has_more_old) return;

        const threshold = 240;
        const remaining = this.dom_logs.scrollHeight - this.dom_logs.scrollTop - this.dom_logs.clientHeight;
        if (remaining <= threshold) {
            this.loadOlderPage();
        }
    }

    loadInitial(onload=null) {
        this.has_more_old = true;
        this.loading_old = false;

        this.loadMeta({
            after_ms: 0,
            contacts_count: 1000,
        }).then(meta => {
            return this.loadSelectedMessageTypes({
                count: this.initial_messages_count,
            }, {
                onload: (messages) => {
                    if (onload) {
                        onload({
                            reporters: meta.reporters,
                            contacts: meta.contacts,
                            groups: meta.channels,
                            advertisements: messages.advertisements,
                            channel_messages: messages.channel_messages,
                            direct_messages: messages.direct_messages,
                        });
                    }
                },
            });
        }).catch(() => {});
    }

    loadOlderPage(onload=null) {
        if (this.loading_old || !this.has_more_old) return;

        const before_ms = this.getOldestMessageTime();
        if (!before_ms) {
            this.has_more_old = false;
            return;
        }

        this.loading_old = true;
        const pageSize = this.older_messages_page_size;

        this.loadSelectedMessageTypes({
            before_ms,
            count: pageSize,
        }, {
            appendOlder: true,
            onload: (messages, loadedCounts) => {
                const loadedMessages =
                    (loadedCounts?.advertisements ?? 0) +
                    (loadedCounts?.channel_messages ?? 0) +
                    (loadedCounts?.direct_messages ?? 0);

                if (loadedMessages < 1) {
                    this.has_more_old = false;
                } else {
                    this.has_more_old =
                        (loadedCounts?.advertisements ?? 0) >= pageSize ||
                        (loadedCounts?.channel_messages ?? 0) >= pageSize ||
                        (loadedCounts?.direct_messages ?? 0) >= pageSize;
                }

                this.loading_old = false;
                if (onload) onload(messages);
            },
        }).catch(() => {
            this.loading_old = false;
        });
    }

    loadNew(onload=null) {
        const metaAfter = this.latest_meta;
        const messagesAfter = this.latest;

        this.loadMeta({
            after_ms: metaAfter,
            contacts_count: 1000,
        }).then(meta => {
            return this.loadMessageIds({
                after_ms: messagesAfter,
                count: this.initial_messages_count,
            }).then(messageIds => {
                const loaders = [
                    ['advertisements', 'api/v1/advertisements', MeshLogAdvertisement],
                    ['channel_messages', 'api/v1/channel_messages', MeshLogChannelMessage],
                    ['direct_messages', 'api/v1/direct_messages', MeshLogDirectMessage],
                ]
                    .filter(([type]) => Array.isArray(messageIds[type]) && messageIds[type].length > 0)
                    .map(([type, url, klass]) => {
                        this.message_type_loading[type] = true;
                        return this.__loadEndpoint(url, {
                            ids: messageIds[type],
                            count: messageIds[type].length,
                        }, this.messages, klass)
                            .then(loaded => {
                                this.message_type_loaded[type] = true;
                                this.message_type_loading[type] = false;
                                return [type, loaded];
                            })
                            .catch(error => {
                                this.message_type_loading[type] = false;
                                throw error;
                            });
                    });

                return Promise.all(loaders).then(results => {
                    const messages = {
                        advertisements: [],
                        channel_messages: [],
                        direct_messages: [],
                    };

                    results.forEach(([type, loaded]) => {
                        messages[type] = loaded;
                    });

                    this.onLoadMessages([
                        ...messages.advertisements,
                        ...messages.channel_messages,
                        ...messages.direct_messages,
                    ]);

                    if (onload) {
                        onload({
                            reporters: meta.reporters,
                            contacts: meta.contacts,
                            groups: meta.channels,
                            advertisements: messages.advertisements,
                            channel_messages: messages.channel_messages,
                            direct_messages: messages.direct_messages,
                        });
                    }
                });
            });
        }).catch(() => {});
    }

    loadOld(onload=null) {
        this.loadOlderPage(onload);
    }

    loadAll(params={}, onload=null) {
        const includeMeta = Number(params.include_meta ?? 1) !== 0;
        const messageCount = params.messages_count ?? params.count ?? this.initial_messages_count;

        const metaPromise = includeMeta
            ? this.loadMeta({
                after_ms: params.after_ms ?? 0,
                before_ms: params.before_ms ?? 0,
                contacts_count: params.contacts_count ?? this.default_contacts_count,
            })
            : Promise.resolve({
                reporters: [],
                contacts: [],
                channels: [],
            });

        metaPromise.then(meta => {
            return this.loadSelectedMessageTypes({
                after_ms: params.after_ms ?? 0,
                before_ms: params.before_ms ?? 0,
                count: messageCount,
            }, {
                appendOlder: params.hasOwnProperty('before_ms') && !includeMeta,
                onload: (messages) => {
                    if (onload) {
                        onload({
                            reporters: meta.reporters,
                            contacts: meta.contacts,
                            groups: meta.channels,
                            advertisements: messages.advertisements,
                            channel_messages: messages.channel_messages,
                            direct_messages: messages.direct_messages,
                        });
                    }
                },
            });
        }).catch(() => {});
    }

    onLoadContacts(contacts = Object.values(this.contacts)) {
        let repHashes = {};
        Object.values(this.contacts).forEach(contact => {
            if (contact.isRepeater()) {
                let hashstr = contact.hash;
                if (!repHashes.hasOwnProperty(hashstr)) {
                    repHashes[hashstr] = 1;
                } else {
                    repHashes[hashstr] += 1;
                }
            }
        });

        contacts.forEach(contact => {
            let latest = contact.last;
            if (!latest) return;

            // Mark dupes
            if (contact.isRepeater()) {
                let hashstr = contact.hash;
                let count = repHashes[hashstr];
                contact.flags.dupe = count > 1;
            }

            this.addContact(contact);
            contact.addToMap(this.map);
        });
        this.updateContactsDom();
    }

    onLoadChannels(channels = Object.values(this.channels)) {
        channels.forEach(channel => {
            this.addChannel(channel);
        });
    }

    addChannel(ch) {
        let isnew = ch.dom ? false : true;
        let dom = ch.createDom();
        ch.updateDom();
        if (isnew) {
            this.dom_settings_reporters.appendChild(dom.cb);
        }
    }

    addMessage(msg, options={}) {
        let isnew = msg.dom ? false : true;
        let dom = msg.createDom();
        msg.updateDom();

        if (isnew) {
            if (options.appendOlder) {
                this.dom_logs.appendChild(dom.container);
            } else {
                // find pos by date
                let inserted = false;
                let newTime = dom.container.dataset.time;
                for (let child of this.dom_logs.children) {
                    const childTime = child.dataset.time;
                    if (newTime > childTime) {
                        this.dom_logs.insertBefore(dom.container, child);
                        inserted = true;
                        break;
                    }
                }

                // If not inserted, append at the end
                if (!inserted) this.dom_logs.appendChild(dom.container);
            }

            if (this.contacts.hasOwnProperty(msg.data.contact_id)) {
                let contact = this.contacts[msg.data.contact_id];
                if (!contact.last || msg.time > contact.last.time) {
                    contact.last = msg;
                    if (msg instanceof MeshLogAdvertisement) {
                        contact.adv = msg;
                    }
                }
            }
            this.onNewMessage(msg);
        }
    }

    addContact(msg) {
        let dom = msg.createDom();
        msg.updateDom();
        this.dom_contacts.appendChild(dom.container);
    }

    updateContactsDom() {
        this.sortContacts();
    }

    updateMessagesDom() {
        for (const [key, msg] of Object.entries(this.messages)) {
            msg.createDom(false);
            msg.updateDom();
        }
        this.updateMessagesFilterWarning();
    }

    onLoadMessages(messages = Object.values(this.messages), options = {}) {
        const sorted = [...messages].sort((a, b) => b.time - a.time);
        sorted.forEach(msg => { this.addMessage(msg, options); });
        this.updateMessagesFilterWarning();
    }

    onLoadAll(loaded = {}, options = {}) {
        this.onLoadMessages(loaded.messages ?? Object.values(this.messages), {
            appendOlder: options.appendOlder === true,
        });

        if (options.includeMeta !== false) {
            this.onLoadContacts(loaded.contacts ?? Object.values(this.contacts));
            this.onLoadChannels(loaded.channels ?? Object.values(this.channels));
        }
    }

    loadReporters(params={}, onload=null) {
        this.__loadEndpoint('api/v1/reporters', params, this.reporters, MeshLogReporter, {
            latestTarget: 'meta',
        }).then(sz => {
            console.log(`${sz.length} reporters loaded`);
            this.__init_reporters();
            if (onload) onload(sz);
        }).catch(() => {});
    }

    loadContacts(params={}, onload=null) {
        const contactParams = {
            ...params,
        };
        if (!contactParams.hasOwnProperty('telemetry') && !contactParams.hasOwnProperty('include_telemetry')) {
            contactParams.telemetry = this.shouldShowContactTelemetry() ? 1 : 0;
        }

        this.__loadEndpoint('api/v1/contacts', contactParams, this.contacts, MeshLogContact, {
            latestTarget: 'meta',
        }).then(sz => {
            console.log(`${sz.length} contacts loaded`);
            this.onLoadContacts(sz);
            if (onload) onload(sz);
        }).catch(() => {});
    }

    loadAdvertisements(params={}, onload=null) {
        this.__loadEndpoint('api/v1/advertisements', params, this.messages, MeshLogAdvertisement)
            .then(sz => {
                console.log(`${sz.length} advertisements loaded`);
                this.message_type_loaded.advertisements = true;
                this.onLoadMessages(sz);
                if (onload) onload(sz);
            }).catch(() => {});
    }

    loadChannels(params={}, onload=null) {
        this.__loadEndpoint('api/v1/channels', params, this.channels, MeshLogChannel, {
            latestTarget: 'meta',
        }).then(sz => {
            console.log(`${sz.length} channels loaded`);
            this.onLoadChannels(sz);
            if (onload) onload(sz);
        }).catch(() => {});
    }

    loadChannelMessages(params={}, onload=null) {
        this.__loadEndpoint('api/v1/channel_messages', params, this.messages, MeshLogChannelMessage)
            .then(sz => {
                console.log(`${sz.length} channels messages loaded`);
                this.message_type_loaded.channel_messages = true;
                this.onLoadMessages(sz);
                if (onload) onload(sz);
            }).catch(() => {});
    }

    loadDirectMessages(params={}, onload=null) {
        this.__loadEndpoint('api/v1/direct_messages', params, this.messages, MeshLogDirectMessage)
            .then(sz => {
                console.log(`${sz.length} direct messages loaded`);
                this.message_type_loaded.direct_messages = true;
                this.onLoadMessages(sz);
                if (onload) onload(sz);
            }).catch(() => {});
    }

    fadeMarkers(opacity=0.2) {
        const empty = this.visible_markers.size < 1;
        Object.entries(this.contacts).forEach(([k,v]) => {
            if (!v.marker) return;

            if (v.dom && v.dom.container) {
                let hidden = v.dom.container.hidden;
                let forcedVisible = this.visible_markers.has(v.data.id);

                if (hidden && !forcedVisible) {
                    v.setMarkerDisplayed(false);
                } else {
                    v.setMarkerDisplayed(true);
                }
            }

            if (empty || this.visible_markers.has(v.data.id)) {
                v.setMarkerOpacity(1);
                v.setMarkerZIndex(1000);
                v.updateTooltip();
            } else {
                v.setMarkerOpacity(opacity);
                v.setMarkerZIndex(2);
                v.updateTooltip('');
            }
        });
    }

    findNearestContact(lat, lon, hash, repeater) {
        let matches = 0;
        let match = false;
        let matchDist = 99999;

        Object.entries(this.contacts).forEach(([k,c]) => {
            if (c.checkHash(hash) && c.adv && (!repeater || c.isRepeater())) {
                let current = [c.adv.data.lat, c.adv.data.lon];
                if (current[0] == 0 && current[1] == 0) return;

                matches++;

                const dist = haversineDistance(lat, lon, current[0], current[1]);

                if (!match || dist < matchDist) {
                    match = c;
                    matchDist = dist;
                }
            }
        });

        if (!match) return false;

        return {
            result: match,
            distance: matchDist,
            matches: matches
        };
    }

    updatePaths() {
        // remove all layers
        const self = this;
        this.link_layers.eachLayer(function (layer) {
            self.link_layers.removeLayer(layer);
        });

        this.visible_markers.clear();

        // temp, dupe prevention
        let links = [];
        let circles = [];
        let decors = {};
        let warnings = [];

        const ln_weight = 2;
        const ln_outline = 4;
        const ln_decor_weight = 3;
        const ln_decor_outline = 5;
        const ln_offset = 8;
        const ln_repeat = 250;

        const linkColor =  '#555';
        const linkStrokeColor = '#fff';

        Object.entries(this.layer_descs).forEach(([k,desc]) => {
            for (const cid of desc.markers) {
                this.visible_markers.add(cid);
            }

            for (let i=0;i<desc.paths.length;i++) {
                let path = desc.paths[i];
                let line_uid = [path.from.contact_id, path.to.contact_id].join('_');
                let line_id = [path.from.contact_id, path.to.contact_id].sort((a, b) => a - b).join('_');
                let decor_id = `${path.reporter.data.id}`;
                let circle_id = `${path.to.contact_id}`;
                let dashArray = path.dashed ? '6 8' : null;

                let linePath = [
                    [path.to.lat, path.to.lon],
                    [path.from.lat, path.from.lon]
                ];

                let line1 = L.polyline(linePath, {renderer: this.canvas_renderer, color: linkStrokeColor, weight: ln_outline, dashArray});
                let line2 = L.polyline(linePath, {renderer: this.canvas_renderer, color: linkColor, weight: ln_weight, dashArray});

                if (!links.includes(line_id)) {
                    links.push(line_id);
                    line1.addTo(this.link_layers);
                    line2.addTo(this.link_layers);
                }

                let dist = haversineDistance(path.to.lat, path.to.lon, path.from.lat, path.from.lon);
                if (dist < 1) {
                    dist = `${Math.round(dist*1000)} m`;
                } else {
                    dist = `${Math.round(dist * 100) / 100} km`;
                }

                line1.bindTooltip(dist, {
                    sticky: true,     // follows mouse
                    direction: 'top'  // optional, tooltip position
                });

                line2.bindTooltip(dist, {
                    sticky: true,     // follows mouse
                    direction: 'top'  // optional, tooltip position
                });

                const mouseover = function(e) {
                    line1.setStyle({ color: 'yellow' });
                    this.openTooltip(); // show tooltip manually
                }

                const mouseout = function(e) {
                    line1.setStyle({ color: linkStrokeColor });
                    this.closeTooltip();
                }

                line1.on('mouseover', mouseover.bind(line1));
                line1.on('mouseout', mouseout.bind(line1));
                line2.on('mouseover', mouseover.bind(line2));
                line2.on('mouseout', mouseout.bind(line2));

                // Circle
                if (path.circle && !circles.includes(circle_id)) {
                    circles.push(circle_id);

                    let r = 1000;
                    let op = .2;

                    let circle = L.circle(linePath[0], {
                        color: linkColor,
                        fillColor: linkColor,
                        fillOpacity: op,
                        radius: r
                    });
                    circle.addTo(this.link_layers);
                }

                // Decoratinos
                if (!decors.hasOwnProperty(line_uid)) {
                    decors[line_uid] = [];
                }

                if (!decors[line_uid].includes(decor_id)) {
                    const offset = ln_offset * decors[line_uid].length;
                    decors[line_uid].push(decor_id);

                    const strokeColor = path.reporter.getStyle().stroke ?? linkStrokeColor;
                    const patterns = [
                        {
                            offset: offset,
                            repeat: ln_repeat,
                            symbol: L.Symbol.arrowHead({
                                pixelSize: 10,
                                polygon: false,
                                pathOptions: { renderer: this.canvas_renderer, stroke: true, color: strokeColor, weight: ln_decor_outline }
                            })
                        },
                        {
                            offset: offset,
                            repeat: ln_repeat,
                            symbol: L.Symbol.arrowHead({
                                pixelSize: 10,
                                polygon: false,
                                pathOptions: { renderer: this.canvas_renderer, stroke: true, color: path.reporter.getStyle().color, weight: ln_decor_weight }
                            })
                        }
                    ];
                    const decorator1 = L.polylineDecorator(line1, {
                        patterns
                    });

                    decorator1.checkVisibility = () => {
                        let visible = meshlog.decor;

                        if (visible) {
                            const p1 = meshlog.map.latLngToLayerPoint(linePath[0]);
                            const p2 = map.latLngToLayerPoint(linePath[1]);
                            const pDist = p1.distanceTo(p2);

                            visible = offset < pDist;
                        }

                        decorator1.setPatterns(visible ? patterns : []);
                    }

                    decorator1.checkVisibility();
                    decorator1.addTo(this.link_layers);
                }

                // Markers
                this.visible_markers;
            }
            warnings = [...warnings, ...desc.warnings];
        });
        warnings = [...new Set(warnings)];
        let warningsStr = `${warnings.length} Path warnings`;
        if (this.dom_warning.dataset.compact != "1") {
            warningsStr = warnings.join("\n");
        }
        this.showWarning(warningsStr);
        this.fadeMarkers();
    }

    // Only adds descriptors, not layers
    showPath(id, path, src, reporter) {
        if (this.layer_descs.hasOwnProperty(id)) return;
        if (!reporter) return;
        if (reporter.isEnabled && !reporter.isEnabled()) return;

        let hashes = path ? path.split(',') : [];
        let prev = {
            lat: reporter.data.lat,
            lon: reporter.data.lon,
            contact_id: reporter.getContactId()
        };

        let addCircle = false;

        if (src && !src.isClient()) {
            hashes.unshift(src.data.public_key);
        } else {
            addCircle = true;
        }

        let desc = {
            paths: [],
            markers: new Set(),
            warnings: []
        }

        for (let i=hashes.length-1;i>=0;i--) {
            let hash = hashes[i];
            let nearest = this.findNearestContact(prev.lat, prev.lon, hash, true);

            // Valid repeater found?
            if (nearest) {
                if (nearest.matches > 1) {
                    desc.warnings.push(`Multiple paths (${nearest.matches}) detected to ${hash}. Showing shortest.`);
                }

                let current = {
                    lat: nearest.result.adv.data.lat,
                    lon: nearest.result.adv.data.lon,
                    contact_id: nearest.result.data.id
                };
                desc.markers.add(nearest.result.data.id);
                desc.paths.push(new MeshLogLinkLayer(prev, current, reporter, addCircle && i == 0, nearest.matches > 1));
                prev = current;
            } else {
                console.log('no nearest: ');
            }
        }

        this.layer_descs[id] = desc;
    }

    hidePath(id) {
        if (!this.layer_descs.hasOwnProperty(id)) return;
        delete this.layer_descs[id];
    }

    refresh() {
        clearTimeout(this.timer);
        const self = this;
        this.loadNew((data) => {
            const count = Object.keys(this.new_messages).length;
            if (count) {
                if (Settings.getBool('notifications.enabled', false)) {
                    new Audio('assets/audio/notif.mp3').play();
                }

                document.getElementById('favicon').setAttribute('href','assets/favicon/faviconr.ico');
                document.title = `(${count}) MeshCore Log`; 
            }
        });
        this.setAutorefresh(this.interval);
    }

    setAutorefresh(interval) {
        this.new_messages = {};
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const parsed = parseInt(interval, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            this.interval = 0;
            return;
        }

        this.interval = Math.max(this.getAutorefreshMinimumSeconds() * 1000, parsed);
        if (this.interval >= this.getAutorefreshMinimumSeconds() * 1000) {
            const self = this;
            this.timer = setTimeout(() => { self.refresh(); }, this.interval);
        }
    }

    onNewMessage(msg) {
        if (msg instanceof MeshLogChannelMessage || msg instanceof MeshLogDirectMessage) {
            const hash = msg.data.hash;
            if (!this.new_messages.hasOwnProperty(hash)) {
                this.new_messages[hash] = [];
            };
            this.new_messages[hash].push(msg);
        }
    }

    clearNotifications() {
        this.new_messages = [];
        document.getElementById('favicon').setAttribute('href','assets/favicon/faviconw.ico');
        document.title = `MeshCore Log`; 
    }

    isReporter(public_key) {
        for (const key in this.reporters) {
            if (this.reporters[key].data.public_key == public_key) {
                return this.reporters[key];
            }
        }
        return false;
    }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (angle) => (angle * Math.PI) / 180;

    const R = 6371; // Radius of the Earth in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

    function escapeXml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function str2color(str, saturation = 65, lightness = 45) {
    let hash = 0x811c9dc5n;
    for (let i = 0; i < str.length; i++) {
        hash = BigInt.asIntN(32, hash ^ BigInt(str.charCodeAt(i)));
        hash = BigInt.asIntN(32, hash * 0x01000193n);
    }

    return `hsl(${Number(hash & 0xFFFFFFFFn) % 360}deg, ${saturation}%, ${lightness}%)`;
}

function createTooltip(element, contents) {
    let tooltip = element.querySelector('.warn-tooltip');
    if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.classList.add('warn-tooltip');
        element.append(tooltip);
    }

    tooltip.textContent = contents;

    if (element.dataset.tooltipBound === "1") {
        return;
    }

    element.dataset.tooltipBound = "1";
    element.addEventListener("mouseenter", () => {
        const rect = element.getBoundingClientRect();
        tooltip.style.display = "block";
        tooltip.style.left = (rect.right + window.scrollX + 8) + "px";
        tooltip.style.top = (rect.top + window.scrollY + (rect.height / 2) - (tooltip.offsetHeight / 2)) + "px";
    });

    element.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
    });
}
