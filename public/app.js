/* =========================================================
   PRIME WEB AGENCY
   FRONTEND APPLICATION
========================================================= */

const API = "/api";


/* =========================================================
   GLOBAL STATE
========================================================= */

let brand = {};
let services = [];
let portfolio = [];
let websiteDemos = [];
let galleryImages = [];


/* =========================================================
   HELPERS
========================================================= */

async function apiRequest(url, options = {}) {

    try {

        const response = await fetch(API + url, {
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {})
            },
            ...options
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(
                data.message ||
                data.error ||
                "Something went wrong"
            );
        }

        return data;

    } catch (error) {

        console.error("API Error:", error);

        throw error;
    }
}


function escapeHTML(value) {

    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


function formatPrice(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return "Contact us";
    }

    const number = Number(value);

    if (Number.isNaN(number)) {
        return escapeHTML(value);
    }

    return "₹" + number.toLocaleString("en-IN");
}


function formatServicePrice(value, currency = "INR") {
    if (value === null || value === undefined || value === "") return "Contact us";
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR", maximumFractionDigits: 2 }).format(Number(value)); }
    catch { return `${escapeHTML(currency || "INR")} ${Number(value || 0).toLocaleString("en-IN")}`; }
}

function safeImageUrl(value) {
    if (typeof value !== "string") return "";
    if (/^\/media\/[a-f0-9-]{36}\.(jpg|png|webp|gif)$/i.test(value)) return value;
    try { const parsed = new URL(value, location.origin); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : ""; }
    catch { return ""; }
}

function normalizeWhatsAppNumber(number) {

    if (!number) {
        return "";
    }

    return String(number).replace(/\D/g, "");
}


function getWhatsAppURL(number, message = "") {

    const cleanNumber =
        normalizeWhatsAppNumber(number);

    if (!cleanNumber) {
        return "#";
    }

    const encodedMessage =
        encodeURIComponent(message);

    return `https://wa.me/${cleanNumber}?text=${encodedMessage}`;
}


/* =========================================================
   LOAD BRAND
========================================================= */

async function loadBrand() {

    try {

        const data =
            await apiRequest("/public/brand");

        brand = data.brand || data || {};

        applyBrand();

    } catch (error) {

        brand = { primary_color: "#c6a66b", secondary_color: "#e5d2a8" };
        applyBrandColors();

        console.error(
            "Unable to load brand settings:",
            error
        );
    }
}

function applyBrandColors() {
    const validHex = (value) => typeof value === "string" && /^#[\da-fA-F]{6}$/.test(value);
    const theme = brand.theme_config && typeof brand.theme_config === "object" ? brand.theme_config : {};
    const defaults = { primary:"#0B1020", secondary:"#202A3B", accent:"#D6B477", background:"#0B1020", backgroundAlt:"#111827", card:"#172033", text:"#F5F3EE", muted:"#B5BDCA", heading:"#F5F3EE", button:"#D6B477", buttonText:"#0B1020", border:"#344055", header:"#0B1020", footer:"#080D18", link:"#D6B477", linkHover:"#E8D4A6", gradientStart:"#0B1020", gradientEnd:"#202A3B" };
    const root = document.documentElement.style;
    const get = key => validHex(theme[key]) ? theme[key] : defaults[key];
    const css = { "--color-primary":get("primary"),"--color-secondary":get("secondary"),"--color-accent":get("accent"),"--color-background":get("background"),"--color-background-alt":get("backgroundAlt"),"--color-card":get("card"),"--color-text":get("text"),"--color-muted":get("muted"),"--color-heading":get("heading"),"--color-button":get("button"),"--color-button-text":get("buttonText"),"--color-border":get("border"),"--color-header":get("header"),"--color-footer":get("footer"),"--color-link":get("link"),"--color-link-hover":get("linkHover"),"--gradient-start":get("gradientStart"),"--gradient-end":get("gradientEnd"),"--bg":get("background"),"--bg-soft":get("backgroundAlt"),"--surface":get("card"),"--surface-strong":get("card"),"--border":get("border"),"--text":get("text"),"--muted":get("muted"),"--muted-light":get("muted"),"--primary-color":get("primary"),"--secondary-color":get("accent"),"--primary":get("button"),"--secondary":get("accent"),"--primary-light":get("linkHover") };
    Object.entries(css).forEach(([key,value])=>root.setProperty(key,value));
    const radii={small:"10px",medium:"18px",large:"26px"}, shadows={none:"none",soft:"0 10px 28px rgba(0,0,0,.12)",medium:"0 20px 55px rgba(0,0,0,.22)",strong:"0 25px 80px rgba(0,0,0,.35)"};
    root.setProperty("--radius-md",radii[theme.radius]||radii.medium);root.setProperty("--radius-lg",theme.radius==="small"?"16px":theme.radius==="large"?"32px":"26px");root.setProperty("--shadow",shadows[theme.shadow]||shadows.medium);
    root.setProperty("--font-family-theme",theme.font==="serif"?'Georgia, "Times New Roman", serif':theme.font==="modern"?'Inter, "Segoe UI", sans-serif':'system-ui, -apple-system, "Segoe UI", sans-serif');
    document.documentElement.dataset.animationIntensity=theme.animation||"medium";
    applyThemePreference(theme.mode||brand.theme_default||"system");
}
function applyBrand() {

    applyBrandColors();

    const companyName =
        brand.company_name ||
        brand.companyName ||
        "Prime Web Agency";

    const shortName =
        brand.short_name ||
        brand.shortName ||
        "Digital • AI • Automation";

    const tagline =
        brand.tagline ||
        "Build Your Digital Presence. Automate Your Business.";

    const description =
        brand.description ||
        "Premium websites and intelligent WhatsApp automation designed for modern businesses.";

    const phone =
        brand.phone ||
        "";

    const email =
        brand.email ||
        "";

    const whatsapp =
        brand.whatsapp ||
        phone ||
        "";

    const logo =
        brand.website_logo_url || brand.logo_url ||
        brand.logoUrl ||
        "";

    const logoImage = document.getElementById("brandLogo");
    if (logoImage && logo) {
        logoImage.decoding = "async";
        logoImage.onerror = () => { logoImage.style.display = "none"; };
        const resolvedLogo = safeImageUrl(logo) || logo;
        logoImage.src = `${resolvedLogo}${resolvedLogo.includes("?") ? "&" : "?"}v=${Date.now()}`;
        logoImage.alt = brand.logo_alt_text || `${companyName} logo`;
        logoImage.style.display = "";
    }

    const legacyHeroTitle = "Build Your Digital Presence. Automate Your Business.";
    const configuredHeroTitle = (brand.hero_title || "").trim();
    const heroTitle = !configuredHeroTitle || configuredHeroTitle === legacyHeroTitle ? "A website that turns visitors into enquiries." : configuredHeroTitle;
    const heroDescription = brand.hero_description || "Strategy, premium design and practical technology to help your business earn trust, explain its value and make it easy for customers to take the next step.";
    const heroTitleNode=document.getElementById("heroTitle");if(heroTitleNode&&heroTitle==="A website that turns visitors into enquiries.")heroTitleNode.innerHTML="A website that turns <span>visitors into enquiries.</span>";else setText("heroTitle",heroTitle);
    setText("aboutTitle", brand.about_title || "Thoughtful technology for growing businesses.");
    setText("aboutDescription", brand.about_description || description);
    setText("footerDescription", brand.footer_text || description);
    setText("brandShortName", brand.short_name || shortName);
    setText("brandDescription", heroDescription);

    const heroImage = document.getElementById("heroImage");
    if (heroImage && brand.hero_image_url) {
        heroImage.decoding = "async";
        heroImage.loading = "eager";
        heroImage.src = brand.hero_image_url;
        heroImage.alt = "";
        heroImage.hidden = false;
        heroImage.addEventListener("error", () => { heroImage.hidden = true; }, { once: true });
    }

    const favicon = document.getElementById("siteFavicon");
    if (favicon && brand.favicon_url) favicon.href = `${brand.favicon_url}${brand.favicon_url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    const seoTitle = brand.seo_title || `${companyName} | Websites & WhatsApp AI Automation`;
    document.title = seoTitle;
    const descriptionMeta = document.getElementById("seoDescription");
    if (descriptionMeta) descriptionMeta.content = brand.seo_description || heroDescription;
    const socialPreview = document.getElementById("socialPreview");
    if (socialPreview && brand.seo_image) socialPreview.content = brand.seo_image;

    const socialLinks = document.getElementById("socialLinks");
    if (socialLinks) {
        const socials = brand.social_links || {};
        socialLinks.innerHTML = Object.entries({ Instagram: socials.instagram, Facebook: socials.facebook, LinkedIn: socials.linkedin, YouTube: socials.youtube })
            .filter(([, url]) => typeof url === "string" && /^https?:\/\//i.test(url))
            .map(([label, url]) => `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`).join("");
    }
    applySectionSettings(brand.section_visibility || {}, brand.section_order || []);
    applyThemePreference(brand.theme_default || "system");


    /* Brand name */

    setText(
        "brandName",
        companyName.toUpperCase()
    );

    setText(
        "footerBrandName",
        companyName.toUpperCase()
    );

    setText(
        "copyrightName",
        companyName
    );


    /* Short name */

    setText(
        "brandShortName",
        shortName
    );


    /* Description */

    setText(
        "brandDescription",
        heroDescription
    );

    setText("footerDescription", brand.footer_text || description);


    /* Logo */

    const logoElement =
        document.getElementById("brandLogo");

    if (logoElement && logo) {
        logoElement.onerror = () => { logoElement.style.display = "none"; };

        logoElement.src = `${logo}${logo.includes("?") ? "&" : "?"}v=${Date.now()}`;

        logoElement.alt =
            `${companyName} Logo`;

        logoElement.style.display =
            "block";
    }


    /* Phone */

    setText(
        "phoneText",
        phone || "Contact us"
    );

    const phoneLink =
        document.getElementById("phoneLink");

    if (phoneLink && phone) {

        phoneLink.href =
            `tel:${phone.replace(/\s/g, "")}`;
    }


    const footerPhone =
        document.getElementById("footerPhone");

    if (footerPhone && phone) {

        footerPhone.textContent =
            phone;

        footerPhone.href =
            `tel:${phone.replace(/\s/g, "")}`;
    }


    /* Email */

    setText(
        "emailText",
        email || "Email us"
    );

    const emailLink =
        document.getElementById("emailLink");

    if (emailLink && email) {

        emailLink.href =
            `mailto:${email}`;
    }


    const footerEmail =
        document.getElementById("footerEmail");

    if (footerEmail && email) {

        footerEmail.textContent =
            email;

        footerEmail.href =
            `mailto:${email}`;
    }


    /* WhatsApp */

    const whatsappLinks = [
        "navWhatsapp",
        "ctaWhatsapp",
        "whatsappLink",
        "footerWhatsapp"
    ];

    whatsappLinks.forEach(id => {

        const element =
            document.getElementById(id);

        if (element) {
            const messages = {
                navWhatsapp: "Hello Prime Web Agency, I’m exploring a website for my business.",
                ctaWhatsapp: "Hello Prime Web Agency, I’d like to plan a website project.",
                whatsappLink: "Hello Prime Web Agency, can we discuss the right website for my business?",
                footerWhatsapp: "Hello Prime Web Agency, I’d like to learn about your website services."
            };
            element.href = getWhatsAppURL(whatsapp, messages[id] || "Hello Prime Web Agency, I want to discuss a project.");
            element.target = "_blank";
            element.rel = "noopener noreferrer";
        }

    });


}


/* =========================================================
   LOAD SERVICES
========================================================= */

async function loadServices() {

    const grid =
        document.getElementById("servicesGrid");

    const select =
        document.getElementById("leadService");


    try {

        const data =
            await apiRequest("/public/services");

        services =
            Array.isArray(data)
                ? data
                : (
                    data.services ||
                    []
                );


        renderServices();

        populateServiceSelect();

    } catch (error) {

        console.error(
            "Unable to load services:",
            error
        );

        if (grid) {

            grid.innerHTML = `
                <div class="loading-card">
                    Services could not be loaded.
                </div>
            `;
        }

        if (select) {

            select.innerHTML = `
                <option value="">
                    Select a service
                </option>
            `;
        }
    }
}


/* =========================================================
   RENDER SERVICES
========================================================= */

function renderServices() {
    const grid = document.getElementById("servicesGrid");
    if (!grid) return;
    if (!services.length) {
        grid.innerHTML = '<div class="loading-card">No published services are available right now.</div>';
        return;
    }
    grid.innerHTML = services.map((service, index) => {
        const name = service.name || "Service";
        const description = service.description || "Details coming soon.";
        const category = service.category || "Digital service";
        const image = safeImageUrl(service.image_url);
        const features = Array.isArray(service.features) ? service.features.slice(0, 5) : [];
        const currency = service.currency || brand.currency || "INR";
        const saleActive = service.sale_active === true;
        const originalPrice = service.original_price ?? service.price;
        const salePrice = service.sale_price ?? service.price;
        return `<article class="service-card">
            <div class="service-image">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(name)}" loading="lazy">` : `<span class="service-image-fallback" aria-hidden="true">${escapeHTML(getServiceIcon(name))}</span>`}${saleActive ? `<span class="service-sale-badge">${escapeHTML(service.offer_badge_text || (service.discount_type === "percentage" ? `${Number(service.discount_value)}% OFF` : "SALE"))}</span>` : ""}</div>
            <div class="service-card-body">
                <span class="service-number">${String(index + 1).padStart(2, "0")} · ${escapeHTML(category)}</span>
                <h3>${escapeHTML(name)}</h3><p>${escapeHTML(description)}</p>${features.length ? `<ul class="service-benefits">${features.map(feature => `<li>${escapeHTML(feature)}</li>`).join("")}</ul>` : ""}
                <div class="service-price"><div><span>${escapeHTML(service.price_label || "Starting at")}</span><strong class="${saleActive ? "sale-current-price" : ""}">${formatServicePrice(saleActive ? salePrice : service.price, currency)}</strong>${saleActive ? `<del class="service-original-price">${formatServicePrice(originalPrice, currency)}</del><small class="service-savings">You Save ${formatServicePrice(service.savings, currency)}</small>` : ""}
                ${Number(service.maintenance_price) > 0 ? `<small class="service-maintenance">Maintenance ${formatServicePrice(service.maintenance_price, currency)} · ${escapeHTML(service.billing_label || "one-time")}</small>` : ""}</div>
                <a href="#contact" class="service-link" data-service="${escapeHTML(name)}" data-service-id="${escapeHTML(service.id)}">Get Started →</a></div>
            </div></article>`;
    }).join("");
    grid.querySelectorAll(".service-image img").forEach((image) => image.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "service-image-fallback";
        fallback.setAttribute("aria-hidden", "true");
        fallback.textContent = getServiceIcon(image.alt);
        image.replaceWith(fallback);
    }, { once: true }));
    grid.querySelectorAll("[data-service]").forEach((link) => link.addEventListener("click", function () {
        const select = document.getElementById("leadService");
        if (select) {
            select.value = "";
            const option = [...select.options].find((item) => String(item.value) === String(this.dataset.serviceId));
            if (option) select.value = option.value;
            updateLeadPriceSummary();
        }
        trackEvent("service_view", { service: this.dataset.service });
        window.setTimeout(() => document.getElementById("leadName")?.focus({ preventScroll: true }), 450);
    }));
}
/* =========================================================
   SERVICE ICON
========================================================= */

function getServiceIcon(name) {

    const text =
        String(name).toLowerCase();


    if (
        text.includes("whatsapp") ||
        text.includes("chatbot") ||
        text.includes("ai")
    ) {
        return "AI";
    }


    if (
        text.includes("hospital") ||
        text.includes("health")
    ) {
        return "HC";
    }


    if (
        text.includes("hotel") ||
        text.includes("restaurant")
    ) {
        return "HL";
    }


    if (
        text.includes("school") ||
        text.includes("education")
    ) {
        return "ED";
    }


    if (
        text.includes("shop") ||
        text.includes("commerce") ||
        text.includes("ecommerce")
    ) {
        return "EC";
    }


    if (
        text.includes("portfolio")
    ) {
        return "PF";
    }


    if (
        text.includes("maintenance")
    ) {
        return "MT";
    }


    return "WD";
}


/* =========================================================
   SERVICE SELECT
========================================================= */

function populateServiceSelect() {

    const select =
        document.getElementById("leadService");

    if (!select) {
        return;
    }


    select.innerHTML = `
        <option value="">
            Select a service
        </option>
    `;


    services.forEach(service => {

        const name =
            service.name ||
            service.title ||
            "Service";


        const option =
            document.createElement("option");


        option.value = service.id == null ? "" : String(service.id);
        if (!/^\d+$/.test(option.value)) option.disabled = true;

        option.dataset.originalPrice = service.original_price ?? service.price ?? "";
        option.dataset.salePrice = service.sale_price ?? service.price ?? "";
        option.dataset.saleActive = String(service.sale_active === true);
        option.dataset.currency = service.currency || brand.currency || "INR";


        option.textContent =
            name;


        select.appendChild(option);

    });

    updateLeadPriceSummary();
}


/* =========================================================
   LOAD PORTFOLIO
========================================================= */

async function loadPortfolio() {

    const grid =
        document.getElementById(
            "portfolioGrid"
        );


    if (!grid) {
        return;
    }


    try {

        const [portfolioResult, demoResult] = await Promise.allSettled([
            apiRequest("/public/portfolio", { cache: "no-store" }),
            apiRequest("/public/demos", { cache: "no-store" })
        ]);
        if (portfolioResult.status === "rejected") throw portfolioResult.reason;
        const data = portfolioResult.value;


        portfolio =
            Array.isArray(data)
                ? data
                : (
                    data.portfolio ||
                    data.projects ||
                    []
                );


        websiteDemos = demoResult.status === "fulfilled" && Array.isArray(demoResult.value.demos) ? demoResult.value.demos : [];
        renderPortfolio();
        if (demoResult.status === "rejected") {
            const demos = document.getElementById("portfolioDemos");
            if (demos) demos.innerHTML = '<p class="portfolio-empty">Published demos could not be loaded. Please try again later.</p>';
        }

    } catch (error) {

        console.error(
            "Unable to load portfolio:",
            error
        );


        grid.innerHTML = `
            <div class="loading-card">
                Portfolio could not be loaded.
            </div>
        `;
        const demos = document.getElementById("portfolioDemos");
        if (demos) demos.innerHTML = '<p class="portfolio-empty">Portfolio content could not be loaded.</p>';
    }
}


/* =========================================================
   RENDER PORTFOLIO
========================================================= */

function portfolioGroup(category="") {
    const value=String(category).toLowerCase();
    if(value.includes("e-commerce")||value.includes("ecommerce")||value.includes("store"))return "E-commerce";
    if(value.includes("portfolio")||value.includes("creative"))return "Portfolio Websites";
    if(value.includes("automation")||value.includes("whatsapp")||value.includes("ai"))return "AI/WhatsApp Automation";
    if(value.includes("business")||value.includes("web")||value.includes("corporate"))return "Business Websites";
    return "Other";
}

function portfolioFilters() {
    const host=document.getElementById("portfolioFilters"); if(!host)return;
    const filters=["All work",...new Set([...portfolio.map(p=>portfolioGroup(p.category||p.project_type)),...websiteDemos.map(d=>portfolioGroup(d.category))])];
    host.innerHTML=filters.map((label,index)=>`<button type="button" class="portfolio-filter ${index===0?"is-active":""}" data-portfolio-filter="${escapeHTML(index===0?"all":label)}" aria-pressed="${index===0}">${escapeHTML(label)}</button>`).join("");
    host.querySelectorAll("[data-portfolio-filter]").forEach(button=>button.addEventListener("click",()=>{host.querySelectorAll("button").forEach(item=>{const active=item===button;item.classList.toggle("is-active",active);item.setAttribute("aria-pressed",String(active));});const selected=button.dataset.portfolioFilter;document.querySelectorAll("[data-portfolio-category]").forEach(card=>card.hidden=selected!=="all"&&card.dataset.portfolioCategory!==selected);trackEvent("portfolio_interaction",{action:"filter",category:selected});}));
}

function serviceForPortfolio(group) {
    const names=services.map(s=>({service:s,name:String(s.name||"").toLowerCase()}));
    if(group==="E-commerce")return names.find(x=>/e-?commerce/.test(x.name))?.service||names.find(x=>/online store|e-?shop/.test(x.name))?.service||null;
    if(group==="AI/WhatsApp Automation")return names.find(x=>/whatsapp/.test(x.name)&&/chatbot|automation|ai/.test(x.name))?.service||names.find(x=>/whatsapp|chatbot|automation/.test(x.name))?.service||null;
    if(group==="Portfolio Websites")return names.find(x=>/portfolio/.test(x.name))?.service||null;
    if(group==="Business Websites")return names.find(x=>/business website|business site/.test(x.name))?.service||names.find(x=>/business/.test(x.name))?.service||null;
    return null;
}

function startPortfolioEnquiry(title,group,service) {
    const select=document.getElementById("leadService"),message=document.getElementById("leadMessage"),chosen=service||serviceForPortfolio(group);
    if(select){select.value="";if(chosen){const option=[...select.options].find(item=>String(item.value)===String(chosen.id));if(option)select.value=option.value;}updateLeadPriceSummary();}
    if(message){message.value=`I’m interested in a website like “${title}” (${group}).`;message.focus({preventScroll:true});}
    document.getElementById("contact")?.scrollIntoView({behavior:"smooth",block:"start"});trackEvent("cta_click",{cta:"portfolio_build_like",category:group});trackEvent("portfolio_interaction",{action:"build_like",category:group});
}

function renderPortfolio() {
    const grid=document.getElementById("portfolioGrid"),demos=document.getElementById("portfolioDemos"); if(!grid||!demos)return;
    portfolioFilters();
    if(!portfolio.length)grid.innerHTML='<div class="portfolio-empty"><strong>Published client projects will appear here when they’re approved to share.</strong><span>Browse the published website demos below.</span></div>';
    else grid.innerHTML=portfolio.map(project=>{const title=project.title||project.name||"Project",category=project.category||project.type||"Digital Project",group=portfolioGroup(category),description=project.description||"",image=safeImageUrl(project.image_url||project.imageUrl||project.image||"");let live="";try{const url=new URL(project.project_url);if(["http:","https:"].includes(url.protocol))live=`<a class="portfolio-live-link" href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer" data-portfolio-open="${escapeHTML(group)}">View live project ↗</a>`;}catch{}return `<article class="portfolio-card" data-portfolio-category="${escapeHTML(group)}"><div class="portfolio-image">${image?`<img src="${escapeHTML(image)}" alt="${escapeHTML(title)}" loading="lazy">`:`<span>${escapeHTML(category)}</span>`}</div><div class="portfolio-content"><span>${escapeHTML(category)}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p><div class="portfolio-card-actions"><button type="button" class="portfolio-build-link" data-build-project="${escapeHTML(title)}" data-build-category="${escapeHTML(group)}">Build a website like this →</button>${live}</div></div></article>`;}).join("");
    if(!portfolio.length){}else grid.querySelectorAll(".portfolio-image img").forEach(image=>image.addEventListener("error",()=>{const fallback=document.createElement("span");fallback.textContent="Published project";image.replaceWith(fallback);},{once:true}));
    demos.innerHTML=websiteDemos.length?websiteDemos.map(d=>{const category=d.category||"Digital project",group=portfolioGroup(category),video=!d.thumbnail_url&&String(d.media_mime_type||"").startsWith("video/"),image=safeImageUrl(d.thumbnail_url||(video?"":d.media_url)||"");const cover=video?`<video src="${escapeHTML(d.media_url)}" controls muted playsinline preload="metadata" aria-label="${escapeHTML(d.title)} demo preview"></video>`:image?`<img src="${escapeHTML(image)}" alt="${escapeHTML(d.title)}" loading="lazy">`:`<span>${escapeHTML(category)}</span>`;let live="";try{const url=new URL(d.website_url);if(["http:","https:"].includes(url.protocol))live=`<a class="portfolio-live-link" href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">View Demo</a>`;}catch{}return `<article class="portfolio-demo-card" data-portfolio-category="${escapeHTML(group)}"><div class="portfolio-image">${cover}</div><div class="portfolio-content"><span>${d.is_featured?"Featured demo":"Website demo"}</span><h3>${escapeHTML(d.title)}</h3><p>${escapeHTML(d.description||"")}</p><div class="portfolio-card-actions">${live}<button type="button" class="portfolio-build-link" data-demo-build="${escapeHTML(d.id)}">${escapeHTML(d.cta_label||"Build a website like this")}</button></div></div></article>`;}).join(""):'<p class="portfolio-empty">No demos are published yet.</p>';
    grid.querySelectorAll("[data-build-project]").forEach(button=>button.addEventListener("click",()=>startPortfolioEnquiry(button.dataset.buildProject,button.dataset.buildCategory,serviceForPortfolio(button.dataset.buildCategory))));
    grid.querySelectorAll("[data-portfolio-open]").forEach(link=>link.addEventListener("click",()=>trackEvent("portfolio_interaction",{action:"open_project",category:link.dataset.portfolioOpen})));
    demos.querySelectorAll(".portfolio-image img").forEach(image=>image.addEventListener("error",()=>{const fallback=document.createElement("span");fallback.textContent="Demo preview unavailable";image.replaceWith(fallback);},{once:true}));
    demos.querySelectorAll(".portfolio-image video").forEach(video=>video.addEventListener("error",()=>{const fallback=document.createElement("span");fallback.textContent="Demo preview unavailable";video.replaceWith(fallback);},{once:true}));
    demos.querySelectorAll("[data-demo-build]").forEach(button=>button.addEventListener("click",()=>{const demo=websiteDemos.find(d=>String(d.id)===button.dataset.demoBuild);if(demo)startPortfolioEnquiry(demo.title,portfolioGroup(demo.category),serviceForPortfolio(portfolioGroup(demo.category)));}));
}

async function loadGallery() {
    const grid = document.getElementById("galleryGrid");
    if (!grid) return;
    try {
        const data = await apiRequest("/public/gallery");
        galleryImages = data.gallery || [];
        if (!galleryImages.length) {
            grid.innerHTML = '<div class="loading-card">Gallery images will appear here when published.</div>';
            return;
        }
        grid.innerHTML = galleryImages.map((image) => {
            const url = safeImageUrl(image.image_url);
            return `<figure class="gallery-card">${url ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(image.alt_text || image.title || "")}" loading="lazy">` : '<div class="service-image-fallback" aria-hidden="true">P</div>'}<figcaption><strong>${escapeHTML(image.title)}</strong><span>${escapeHTML(image.caption || image.category || "")}</span></figcaption></figure>`;
        }).join("");
        grid.querySelectorAll("img").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
    } catch (error) {
        grid.innerHTML = `<div class="loading-card">Gallery could not be loaded: ${escapeHTML(error.message)}</div>`;
    }
}

async function loadApprovedReviews(){const section=document.getElementById("customerReviews"),grid=document.getElementById("approvedReviewsGrid"),summary=document.getElementById("publicReviewSummary");if(!section||!grid)return;try{const data=await apiRequest("/public/reviews"),reviews=Array.isArray(data.reviews)?data.reviews:[];if(!reviews.length){grid.innerHTML='<p class="review-empty">No approved reviews yet. You can share feedback for admin review below.</p>';if(summary)summary.textContent="Reviews are published only after approval.";}else{grid.innerHTML=reviews.map(r=>{const date=r.created_at?new Date(r.created_at):null,dateText=date&&!Number.isNaN(date.getTime())?date.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}):"",id=escapeHTML(r.id),vote=r.viewer_vote||"",helpful=Number(r.helpful_count)||0,notHelpful=Number(r.not_helpful_count)||0;return '<article class="approved-review-card" data-review-card="'+id+'">'+(r.is_featured?'<span class="section-label">FEATURED REVIEW</span>':'')+(r.reviewer_photo_url?'<img class="reviewer-avatar" src="'+escapeHTML(r.reviewer_photo_url)+'" alt="" loading="lazy">':'')+'<div class="review-stars" role="img" aria-label="Rated '+Number(r.rating)+' out of 5">'+String.fromCharCode(9733).repeat(Math.max(0,Math.min(5,Number(r.rating)||0)))+'</div><blockquote>'+escapeHTML(r.quote)+'</blockquote><p><strong>'+escapeHTML(r.display_name)+'</strong>'+(r.company_name?'<span>'+escapeHTML(r.company_name)+'</span>':'')+'</p>'+(dateText?'<time datetime="'+date.toISOString()+'">'+escapeHTML(dateText)+'</time>':'')+'<div class="review-voting"><p>Was this review helpful?</p><div><button type="button" data-vote="yes" data-review-id="'+id+'" aria-pressed="'+(vote==="helpful")+'" '+(vote?'disabled':'')+'>Yes, helpful <span data-helpful-count>'+helpful+'</span></button><button type="button" data-vote="no" data-review-id="'+id+'" aria-pressed="'+(vote==="not_helpful")+'" '+(vote?'disabled':'')+'>Not helpful <span data-not-helpful-count>'+notHelpful+'</span></button></div><small data-vote-message role="status">'+(vote?'Thanks for your feedback.':'')+'</small></div></article>';}).join("");if(summary)summary.textContent=Number(data.average||0).toFixed(1)+' out of 5 | '+Number(data.count??reviews.length)+' approved review'+(Number(data.count??reviews.length)===1?'':'s');}section.hidden=false;}catch(error){grid.innerHTML='<p class="review-empty">Reviews are temporarily unavailable. Please try again later.</p>';section.hidden=false;if(summary)summary.textContent="Review data could not be loaded.";console.error("Unable to load public reviews:",error);}}
async function voteOnReview(event){const button=event.target.closest('[data-vote][data-review-id]');if(!button)return;event.preventDefault();const card=button.closest('[data-review-card]');if(!card||card.dataset.voting==='true')return;card.dataset.voting='true';card.querySelectorAll('[data-vote]').forEach(item=>item.disabled=true);const helpful=button.dataset.vote==='yes';try{const result=await apiRequest(`/public/reviews/${encodeURIComponent(button.dataset.reviewId)}/vote`,{method:'POST',body:JSON.stringify({helpful})});card.querySelector('[data-helpful-count]').textContent=String(result.helpful_count);card.querySelector('[data-not-helpful-count]').textContent=String(result.not_helpful_count);card.querySelectorAll('[data-vote]').forEach(item=>{item.setAttribute('aria-pressed',String((item.dataset.vote==='yes')===helpful));item.disabled=true;});card.querySelector('[data-vote-message]').textContent='Thanks for your feedback.';}catch(error){card.querySelector('[data-vote-message]').textContent=error.message||'Your vote could not be saved. Please try again.';if(error.message?.includes('already voted'))await loadApprovedReviews();else card.querySelectorAll('[data-vote]').forEach(item=>item.disabled=false);}finally{if(card.isConnected)card.dataset.voting='false';}}async function submitPublicReview(event){event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),message=document.getElementById("publicReviewMessage");if(button.disabled)return;button.disabled=true;message.hidden=true;try{const result=await apiRequest("/public/reviews",{method:"POST",body:JSON.stringify({display_name:document.getElementById("publicReviewName").value.trim(),rating:Number(document.getElementById("publicReviewRating").value),quote:document.getElementById("publicReviewQuote").value.trim(),attribution_consent:document.getElementById("publicReviewConsent").checked,website_url:document.getElementById("publicReviewWebsite").value})});form.reset();message.textContent=result.message||"Thank you. Your review is awaiting moderation.";message.className="notice success";message.hidden=false;}catch(error){message.textContent=error.message||"Unable to submit your review.";message.className="notice error";message.hidden=false;}finally{button.disabled=false;}}
/* =========================================================
   AI DEMO
========================================================= */

async function sendAIMessage(message) {

    const messages =
        document.getElementById(
            "aiMessages"
        );


    if (!messages) {
        return;
    }


    /* User message */

    const userBubble =
        document.createElement("div");

    userBubble.className =
        "demo-message user-demo-message";

    userBubble.textContent =
        message;

    messages.appendChild(
        userBubble
    );


    /* Loading bubble */

    const loadingBubble =
        document.createElement("div");

    loadingBubble.className =
        "demo-message ai-demo-message";

    loadingBubble.textContent =
        "Thinking...";

    messages.appendChild(
        loadingBubble
    );


    messages.scrollTop =
        messages.scrollHeight;


    try {

        const data =
            await apiRequest(
                "/ai/demo",
                {
                    method: "POST",

                    body: JSON.stringify({
                        message
                    })
                }
            );


        const reply =
            data.reply ||
            data.message ||
            data.response ||
            "Thanks! Our team will help you shortly.";


        loadingBubble.textContent =
            reply;


    } catch (error) {

        loadingBubble.textContent =
            "The assistant could not respond right now. Please try again, or use the contact form below.";

        // Keep logs useful without recording visitor messages or request contents.
        console.error("AI demo request failed.");
    }


    messages.scrollTop =
        messages.scrollHeight;
}


/* =========================================================
   AI FORM
========================================================= */

function setupAIForm() {

    const form =
        document.getElementById(
            "aiDemoForm"
        );


    const input =
        document.getElementById(
            "aiDemoInput"
        );


    if (!form || !input) {
        return;
    }


    form.addEventListener(
        "submit",
        async event => {

            event.preventDefault();


            const message =
                input.value.trim();


            if (!message) {
                return;
            }


            input.value = "";


            await sendAIMessage(
                message
            );

        }
    );
}


/* =========================================================
   LEAD FORM
========================================================= */

function setupLeadForm() {

    const form =
        document.getElementById(
            "leadForm"
        );


    if (!form) {
        return;
    }


    form.addEventListener(
        "submit",
        async event => {

            event.preventDefault();


            const messageBox =
                document.getElementById(
                    "leadFormMessage"
                );


            const name =
                document.getElementById(
                    "leadName"
                )?.value.trim();


            const phone =
                document.getElementById(
                    "leadPhone"
                )?.value.trim();


            const email =
                document.getElementById(
                    "leadEmail"
                )?.value.trim();


            const company =
                document.getElementById(
                    "leadCompany"
                )?.value.trim();


            const service =
                document.getElementById(
                    "leadService"
                )?.value;


            const projectMessage =
                document.getElementById(
                    "leadMessage"
                )?.value.trim();


            if (!name) {

                showFormMessage(
                    "Please enter your name.",
                    "error"
                );

                return;
            }


            const submitButton =
                form.querySelector(
                    "button[type='submit']"
                );


            if (submitButton) {

                submitButton.disabled =
                    true;

                submitButton.innerHTML =
                    "Submitting...";
            }


            try {

                await apiRequest(
                    "/leads",
                    {
                        method: "POST",

                        body: JSON.stringify({

                            name,

                            phone,

                            email,

                            company,

                            service,

                            message:
                                projectMessage,

                            source:
                                "website"

                        })
                    }
                );


                showFormMessage(
                    "Thank you! Your enquiry has been submitted successfully.",
                    "success"
                );


                form.reset();


                trackEvent(
                    "lead_submit"
                );


            } catch (error) {

                console.error(
                    "Lead submission error:",
                    error
                );


                showFormMessage(
                    error.message ||
                    "Unable to submit enquiry. Please try again.",
                    "error"
                );

            } finally {

                if (submitButton) {

                    submitButton.disabled =
                        false;

                    submitButton.innerHTML =
                        `
                        Submit Enquiry
                        <span>→</span>
                        `;
                }
            }

        }
    );
}


/* =========================================================
   FORM MESSAGE
========================================================= */

function showFormMessage(
    message,
    type
) {

    const box =
        document.getElementById(
            "leadFormMessage"
        );


    if (!box) {
        return;
    }


    box.textContent =
        message;


    box.className =
        `form-message ${type}`;
}

const leadFiles = [];
let leadPreviewUrls = [];
let leadRequestKey = (() => { try { return sessionStorage.getItem("pwa_lead_request_key"); } catch { return null; } })();
let leadSubmitting = false;
const MAX_CLIENT_LEAD_FILES = 5;
const MAX_CLIENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CLIENT_TOTAL_BYTES = 6 * 1024 * 1024;

function updateLeadPriceSummary() {
    const summary = document.getElementById("leadPriceSummary");
    const select = document.getElementById("leadService");
    if (!summary || !select) return;
    const option = select.selectedOptions[0];
    if (!option?.value) { summary.textContent = "Choose a service to see its current price. Sending a request does not purchase or charge you for a service."; return; }
    const currency = option.dataset.currency || "INR";
    const original = option.dataset.originalPrice;
    const sale = option.dataset.salePrice;
    summary.textContent = option.dataset.saleActive === "true"
        ? `${option.textContent}: ${formatServicePrice(sale, currency)} sale price (original ${formatServicePrice(original, currency)}). This is an enquiry only; no payment is taken.`
        : `${option.textContent}: ${formatServicePrice(original, currency)}. This is an enquiry only; no payment is taken.`;
}

function renderLeadAttachmentPreviews() {
    const host = document.getElementById("leadAttachmentPreview");
    if (!host) return;
    leadPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    leadPreviewUrls = leadFiles.map((file) => URL.createObjectURL(file));
    host.innerHTML = leadFiles.map((file, index) => `<figure class="lead-attachment-thumb"><img src="${leadPreviewUrls[index]}" alt="Preview of ${escapeHTML(file.name)}"><figcaption>${escapeHTML(file.name)} · ${(file.size / 1024).toFixed(0)} KB</figcaption><button type="button" data-remove-lead-file="${index}" aria-label="Remove ${escapeHTML(file.name)}">Remove</button></figure>`).join("");
    host.querySelectorAll("[data-remove-lead-file]").forEach((button) => button.addEventListener("click", () => { leadFiles.splice(Number(button.dataset.removeLeadFile), 1); leadRequestKey = null; renderLeadAttachmentPreviews(); }));
}

function addLeadFiles(files) {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    for (const file of files) {
        const existingSize = leadFiles.reduce((sum, item) => sum + item.size, 0);
        if (!allowed.has(file.type) || !/\.(jpe?g|png|webp)$/i.test(file.name)) { showFormMessage("Only valid JPEG, PNG, and WebP images are allowed.", "error"); continue; }
        if (file.size <= 0 || file.size > MAX_CLIENT_FILE_BYTES) { showFormMessage("Each image must be no larger than 2 MB.", "error"); continue; }
        if (leadFiles.length >= MAX_CLIENT_LEAD_FILES || existingSize + file.size > MAX_CLIENT_TOTAL_BYTES) { showFormMessage("This request allows up to 5 images and 6 MB total.", "error"); break; }
        leadFiles.push(file);
    }
    renderLeadAttachmentPreviews();
}

async function encodeLeadFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return { name: file.name, mime_type: file.type, data_base64: btoa(binary) };
}

function submitLeadRequest(payload, onProgress) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", `${API}/leads`);
        request.setRequestHeader("Content-Type", "application/json");
        request.upload.addEventListener("progress", (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); });
        request.addEventListener("load", () => {
            let data = {};
            try { data = JSON.parse(request.responseText); } catch { /* invalid JSON response */ }
            if (request.status >= 200 && request.status < 300) resolve(data);
            else reject(new Error(data.error || "Unable to submit your request. Please try again."));
        });
        request.addEventListener("error", () => reject(new Error("Network error while submitting. Your request may have reached us; retrying will not create a duplicate.")));
        request.addEventListener("timeout", () => reject(new Error("The request took too long. Retry to check its saved status.")));
        request.timeout = 90000;
        request.send(JSON.stringify(payload));
    });
}

function showLeadFallback(url) {
    if (!url) return;
    const box = document.getElementById("leadFormMessage");
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "lead-manual-whatsapp";
    link.textContent = "Open WhatsApp and send the prefilled message manually";
    box.append(document.createElement("br"), link);
}

function setupLeadRequestForm() {
    const form = document.getElementById("leadForm");
    if (!form || form.dataset.leadHandlerAttached === "true") return;
    form.dataset.leadHandlerAttached = "true";
    const fileInput = document.getElementById("leadAttachmentsInput");
    const drop = document.getElementById("leadAttachmentDrop");
    const serviceSelect = document.getElementById("leadService");
    fileInput?.addEventListener("change", () => { addLeadFiles([...fileInput.files]); fileInput.value = ""; });
    drop?.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("drag-over"); });
    drop?.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop?.addEventListener("drop", (event) => { event.preventDefault(); drop.classList.remove("drag-over"); addLeadFiles([...event.dataTransfer.files]); });
    serviceSelect?.addEventListener("change", updateLeadPriceSummary);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (leadSubmitting) return;
        const name = document.getElementById("leadName").value.trim();
        const localPhone = document.getElementById("leadPhone").value.trim();
        const email = document.getElementById("leadEmail").value.trim();
        const countryCode = document.getElementById("leadCountryCode").value;
        const serviceId = serviceSelect.value;
        const option = serviceSelect.selectedOptions[0];
        const message = document.getElementById("leadMessage").value.trim();
        if (!name || !localPhone || !document.getElementById("leadConsent").checked) { showFormMessage("Enter your name and mobile number, then agree to the privacy consent.", "error"); return; }
        const phoneDigits=localPhone.replace(/[\s().-]/g,"");if(!/^\d{6,14}$/.test(phoneDigits)){showFormMessage("Enter a valid mobile number with 6–14 digits.","error");document.getElementById("leadPhone").focus();return;}
        if (!/^\d+$/.test(serviceId)) { showFormMessage("Choose one available service so we can direct your enquiry.", "error"); serviceSelect.focus(); return; }
        if (!message) { showFormMessage("Add a short description of what you want the website or service to help you achieve.", "error"); document.getElementById("leadMessage").focus(); return; }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFormMessage("Enter a valid email address or leave it blank.", "error"); return; }
        leadSubmitting = true;
        const button = form.querySelector("button[type='submit']");
        if (button) { button.disabled = true; button.textContent = "Uploading and submitting…"; }
        const progress = document.getElementById("leadUploadProgress");
        const progressBar = document.getElementById("leadUploadProgressBar");
        const progressText = document.getElementById("leadUploadProgressText");
        progress.hidden = false; progressBar.value = 0; progressText.textContent = "Preparing images…";
        try {
            const encodedFiles = await Promise.all(leadFiles.map(encodeLeadFile));
            const budget = document.getElementById("leadBudget")?.value || "";
            const projectMessage = budget ? `Approximate budget: ${budget}.\n\n${message}` : message;
            const payload = { name, country_code: countryCode, local_phone: localPhone, email: email || null, service_id: serviceId, service: option?.textContent || null, message: projectMessage, consent: true, website_url: document.getElementById("leadWebsite").value, attachments: encodedFiles, source: window.location.pathname.slice(0,100) || "website" };
            const signature = JSON.stringify({ ...payload, attachments: encodedFiles.map(file => [file.name,file.mime_type,file.data_base64.length]) });
            let storedSignature = null;
            try { storedSignature = sessionStorage.getItem("pwa_lead_request_signature"); } catch { /* Keep request state in memory when storage is unavailable. */ }
            if (!leadRequestKey || storedSignature !== signature) leadRequestKey = crypto.randomUUID();
            payload.request_key = leadRequestKey;
            try { sessionStorage.setItem("pwa_lead_request_key", leadRequestKey); sessionStorage.setItem("pwa_lead_request_signature", signature); } catch { /* Keep request state in memory when storage is unavailable. */ }
            const response = await submitLeadRequest(payload, (percent) => { progressBar.value = percent; progressText.textContent = `Uploading request and images… ${percent}%`; });
            progressBar.value = 100;
            const waStatus = response.whatsapp?.status;
            const confirmation = `Thank you. Request ${response.lead_reference} is saved. ${response.whatsapp?.message || (waStatus === "accepted" ? "WhatsApp accepted the notification; delivery confirmation may follow." : "Your request has been received.")}`;
            showFormMessage(confirmation, "success");
            showLeadFallback(response.whatsapp?.manual_url);
            form.reset();
            leadFiles.splice(0);
            leadRequestKey = null;
            try { sessionStorage.removeItem("pwa_lead_request_key"); } catch { /* Storage may be unavailable. */ }
            try { sessionStorage.removeItem("pwa_lead_request_signature"); } catch { /* Storage may be unavailable. */ }
            renderLeadAttachmentPreviews();
            updateLeadPriceSummary();
            trackEvent("lead_submit", { service: option?.textContent || "general" });
        } catch (error) {
            showFormMessage(error.message || "Unable to submit your request. Please try again.", "error");
        } finally {
            leadSubmitting = false;
            window.setTimeout(() => { progress.hidden = true; }, 1200);
            if (button) { button.disabled = false; button.textContent = "Submit Request →"; }
        }
    });
}


/* =========================================================
   ANALYTICS
========================================================= */

async function trackEvent(
    eventName,
    metadata = {}
) {

    try {

        let sessionId = localStorage.getItem("prime_web_agency_session_id");

        if (!sessionId) {
            sessionId = window.crypto?.randomUUID
                ? window.crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem("prime_web_agency_session_id", sessionId);
        }

        await apiRequest(
            "/analytics/event",
            {
                method: "POST",

                body: JSON.stringify({

                    event_name:
                        eventName,

                    page:
                        window.location.pathname,

                    session_id:
                        sessionId,

                    metadata

                })
            }
        );

    } catch (error) {

        /*
         Analytics failure should never
         break the website.
        */

        console.debug(
            "Analytics unavailable:",
            error.message
        );
    }
}

function setupConversionJourney(){
    document.querySelectorAll("#heroEnquiryCta,#stickyProjectCta").forEach(link=>link.addEventListener("click",()=>trackEvent("cta_click",{cta:link.id})));
    const sticky=document.getElementById("stickyProjectCta"),contact=document.getElementById("contact");
    if(sticky&&contact&&"IntersectionObserver" in window)new IntersectionObserver(entries=>sticky.classList.toggle("is-hidden",entries[0]?.isIntersecting===true),{threshold:.12}).observe(contact);
    const form=document.getElementById("leadForm");
    if(form){let started=false;form.addEventListener("focusin",()=>{if(!started){started=true;trackEvent("enquiry_start");}});}
}


/* =========================================================
   WHATSAPP TRACKING
========================================================= */

function setupWhatsAppTracking() {

    const ids = [
        "navWhatsapp",
        "ctaWhatsapp",
        "whatsappLink",
        "footerWhatsapp"
    ];


    ids.forEach(id => {

        const element =
            document.getElementById(id);


        if (!element) {
            return;
        }


        element.addEventListener(
            "click",
            () => {

                trackEvent(
                    "whatsapp_click",
                    { cta: id }
                );

            }
        );

    });
}


/* =========================================================
   MOBILE MENU
========================================================= */

function setupMobileMenu() {
    const button = document.getElementById("mobileMenuBtn");
    const menu = document.getElementById("mobileMenu");
    if (!button || !menu || button.dataset.menuBound === "true") return;

    button.dataset.menuBound = "true";
    button.type = "button";
    button.setAttribute("aria-controls", menu.id);
    const setOpen = (open) => {
        menu.classList.toggle("active", open);
        button.setAttribute("aria-expanded", String(open));
        button.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    setOpen(menu.classList.contains("active"));
    button.addEventListener("click", () => setOpen(!menu.classList.contains("active")));
    menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setOpen(false)));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && menu.classList.contains("active")) {
            setOpen(false);
            button.focus();
        }
    });
}

/* =========================================================
   GENERIC TEXT HELPER
========================================================= */

function setText(
    id,
    value
) {

    const element =
        document.getElementById(id);


    if (element) {

        element.textContent =
            value;
    }
}


/* =========================================================
   YEAR
========================================================= */

function setCurrentYear() {

    setText(
        "currentYear",
        new Date().getFullYear()
    );
}


/* =========================================================
   NAVIGATION ANALYTICS
========================================================= */

function setupNavigationTracking() {

    document
        .querySelectorAll(
            'a[href^="#"]'
        )
        .forEach(link => {

            link.addEventListener(
                "click",
                () => {

                    const target =
                        link.getAttribute(
                            "href"
                        );


                    if (target &&
                        target !== "#") {

                        trackEvent(
                            "navigation_click",
                            {
                                target
                            }
                        );

                    }
                }
            );

        });
}


/* =========================================================
   INITIALIZATION
========================================================= */

function adNode(tag, text, cls){const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;}
function renderPublicAds(items){document.querySelectorAll("[data-ad-placement-root]").forEach(node=>node.remove());const positions={top_strip:document.querySelector("main"),below_hero:document.querySelector(".hero"),promo_section:document.querySelector("#services"),above_footer:document.querySelector("#customerReviews")||document.querySelector("footer")};const groups=new Map();for(const ad of items||[]){if(!positions[ad.placement])continue;if(!groups.has(ad.placement))groups.set(ad.placement,[]);groups.get(ad.placement).push(ad);}for(const [position,ads]of groups){const anchor=positions[position],root=adNode("section",null,`public-ads public-ads-${position}`);root.dataset.adPlacementRoot=position;root.setAttribute("aria-label","Promotions");for(const ad of ads){const card=adNode(ad.cta_url?"a":"article",null,`public-ad public-ad-${ad.ad_type} ad-motion-${ad.animation}`);card.style.setProperty("--ad-bg",/^#[0-9a-f]{6}$/i.test(ad.background_color)?ad.background_color:"#172554");card.style.setProperty("--ad-color",/^#[0-9a-f]{6}$/i.test(ad.text_color)?ad.text_color:"#ffffff");card.style.setProperty("--ad-speed",`${Math.max(.25,Math.min(5,Number(ad.animation_speed)||1))}s`);card.style.textAlign=["left","center","right"].includes(ad.text_align)?ad.text_align:"center";if(ad.cta_url){try{const u=new URL(ad.cta_url,location.origin);if(!["http:","https:"].includes(u.protocol))continue;card.href=u.href;if(u.origin!==location.origin){card.target="_blank";card.rel="noopener noreferrer";}}catch{continue;}}if(ad.media_url){if(ad.media_mime_type?.startsWith("video/")){const video=adNode("video",null,"public-ad-media");video.controls=true;video.muted=true;video.playsInline=true;video.preload="none";if(ad.poster_url)video.poster=ad.poster_url;const source=adNode("source");source.src=ad.media_url;source.type=ad.media_mime_type;video.append(source,adNode("span","Your browser cannot play this promotional video."));video.addEventListener("error",()=>video.replaceWith(adNode("p","Promotional video is unavailable.")));card.append(video);}else{const img=adNode("img");img.className="public-ad-media";img.src=ad.media_url;img.alt=ad.headline||"Advertisement";img.loading="lazy";img.decoding="async";img.addEventListener("error",()=>card.remove());card.append(img);}}const copy=adNode("div",null,"public-ad-copy");if(ad.headline)copy.append(adNode("h2",ad.headline));if(ad.description)copy.append(adNode("p",ad.description));if(ad.cta_text&&ad.cta_url)copy.append(adNode("span",ad.cta_text,"public-ad-cta"));if(copy.childNodes.length)card.append(copy);if(!card.childNodes.length)continue;root.append(card);}if(!root.childNodes.length)continue;if(position==="top_strip")anchor.before(root);else if(position==="above_footer")anchor.before(root);else anchor.after(root);}}
async function loadAdvertisements(){const state=document.getElementById("publicAdStatus");if(state){state.textContent="Loading current promotions…";state.hidden=false;}try{const response=await fetch(API+"/public/advertisements",{headers:{Accept:"application/json"},cache:"no-store"});if(!response.ok)throw new Error("Promotions are temporarily unavailable.");const data=await response.json();renderPublicAds(data.advertisements||[]);if(state){state.textContent=(data.advertisements||[]).length?"":"No promotions are active right now.";state.hidden=(data.advertisements||[]).length>0;}}catch{if(state){state.textContent="Promotions are temporarily unavailable.";state.hidden=false;}}}

async function loadManagedDemos(){const section=document.getElementById("managedDemos"),grid=document.getElementById("managedDemosGrid"),status=document.getElementById("managedDemosStatus"),retry=document.getElementById("retryManagedDemos");if(!section||!grid)return;section.hidden=false;grid.replaceChildren();if(status){status.classList.remove("error");status.textContent="Loading published demos…";status.hidden=false;}if(retry)retry.hidden=true;try{const data=await apiRequest("/public/demos",{cache:"no-store"}),items=Array.isArray(data.demos)?data.demos:[];grid.replaceChildren();for(const d of items){const card=document.createElement("article");card.className="managed-demo-card";const media=d.thumbnail_url||d.media_url;if(media){if((d.media_mime_type||"").startsWith("video/")&&!d.thumbnail_url){const v=document.createElement("video");v.src=media;v.controls=true;v.muted=true;v.playsInline=true;v.preload="none";v.setAttribute("aria-label",`${d.title} demo preview`);v.addEventListener("error",()=>v.replaceWith(adNode("div","Demo video is unavailable. Use the project enquiry button to request a similar website.","demo-media-fallback")),{once:true});card.append(v);}else{const img=document.createElement("img");img.src=media;img.alt=`${d.title} website preview`;img.loading="lazy";img.decoding="async";img.addEventListener("error",()=>{img.replaceWith(adNode("div","Preview image unavailable","demo-media-fallback"));});card.append(img);}}const body=document.createElement("div");body.className="managed-demo-copy";const label=adNode("span",`DEMO · ${d.category||"Website"}${d.demo_label?` · ${d.demo_label}`:""}`,"section-label");body.append(label,adNode("h3",d.title||"Website demo"),adNode("p",d.description||"Demo concept. Request a similar website tailored to your business."));if(d.price_label)body.append(adNode("strong",d.price_label));const actions=adNode("div",null,"portfolio-card-actions");const safeLink=value=>{try{const url=new URL(value);return ["https:","http:"].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};const liveUrl=safeLink(d.website_url);if(liveUrl){const link=adNode("a","View Live Demo","portfolio-live-link");link.href=liveUrl;link.target="_blank";link.rel="noopener noreferrer";actions.append(link);}const build=adNode("button",d.cta_label||"Build a Website Like This","portfolio-build-link");build.type="button";build.addEventListener("click",()=>startPortfolioEnquiry(d.title,d.category,serviceForPortfolio(d.category)));actions.append(build);if(d.demo_credentials_public&&d.demo_login_url&&safeLink(d.demo_login_url)){const login=adNode("a","Open demo account");login.href=safeLink(d.demo_login_url);login.target="_blank";login.rel="noopener noreferrer";actions.append(login);if(d.demo_username)actions.append(adNode("small",`Demo username: ${d.demo_username}`));if(d.demo_instructions)actions.append(adNode("small",d.demo_instructions));}body.append(actions);card.append(body);grid.append(card);}if(status){status.textContent=items.length?"":"There are no public demos available yet.";status.hidden=items.length>0;}if(!items.length)grid.append(adNode("p","New previews will appear here when they are published.","empty-state"));}catch(error){console.error("Public demos could not be loaded:",error);if(status){status.textContent="Published demos are temporarily unavailable. Please try again.";status.classList.add("error");status.hidden=false;}if(retry)retry.hidden=false;} }

async function initializeApp() {

    setCurrentYear();

    setupMobileMenu();

    setupAIForm();

    setupLeadRequestForm();
    document.getElementById("publicReviewForm")?.addEventListener("submit",submitPublicReview);document.getElementById("approvedReviewsGrid")?.addEventListener("click",voteOnReview);

    setupWhatsAppTracking();

    setupNavigationTracking();
    setupConversionJourney();


    await Promise.all([
        loadBrand(),
        loadServices(),
        loadPortfolio(),
        loadGallery(),
        loadApprovedReviews(),
        loadManagedDemos()
    ]);
    setupScrollReveal();
    document.getElementById("retryManagedDemos")?.addEventListener("click",loadManagedDemos);
    loadAdvertisements();
    window.setInterval(loadAdvertisements, 60000);


    trackEvent(
        "page_view"
    );
}


/* =========================================================
   START
========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    initializeApp
);

function setupScrollReveal(){if(!('IntersectionObserver' in window)||document.documentElement.dataset.animationIntensity==='none'||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('motion-entered');observer.unobserve(entry.target);}}),{threshold:.08,rootMargin:'0px 0px -24px 0px'});document.querySelectorAll('.section-heading,.service-card,.portfolio-card,.managed-demo-card,.process-card,.approved-review-card').forEach(node=>observer.observe(node));}
function applySectionSettings(visibility = {}, order = []) {
    const supported = ["services", "about", "portfolio", "automation", "process", "gallery", "contact"];
    supported.forEach((section) => {
        const element = document.querySelector(`[data-cms-section="${section}"]`);
        if (element && visibility[section] !== undefined) element.hidden = visibility[section] === false;
    });
    const main = document.querySelector("main");
    const defaults = ["services", "about", "portfolio", "automation", "process", "gallery", "contact"];
    const sequence = [...new Set([...order, ...defaults])].filter((section) => supported.includes(section));
    if (main) {
        const layout = [document.querySelector(".hero"),document.querySelector(".stats-section")];
        sequence.forEach((section) => {
        const element = document.querySelector(`[data-cms-section="${section}"]`);
            if (section === "contact") layout.push(document.querySelector(".cta-section"));
            if (element) layout.push(element);
            if (section === "portfolio") layout.push(document.getElementById("managedDemos"));
            if (section === "automation") layout.push(document.querySelector(".ai-demo-section"));
        });
        layout.push(document.getElementById("customerReviews"));
        layout.filter(element=>element?.parentElement===main).forEach(element=>main.appendChild(element));
    }
}

function applyThemePreference(defaultTheme = "system") {
    const root = document.documentElement;
    const storageKey = "prime-web-agency-theme";
    let selected = defaultTheme;
    try { selected = localStorage.getItem(storageKey) || defaultTheme || "system"; }
    catch { selected = defaultTheme || "system"; }
    if (!["system", "light", "dark"].includes(selected)) selected = "system";
    const update = () => {
        const resolved = selected === "system"
            ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
            : selected;
        root.dataset.theme = resolved;
        document.querySelectorAll("[data-theme-selector]").forEach((selector) => { selector.value = selected; });
    };
    update();
    document.querySelectorAll("[data-theme-selector]").forEach((selector) => {
        selector.addEventListener("change", () => {
            selected = selector.value;
            try { localStorage.setItem(storageKey, selected); } catch { /* preference remains for this page */ }
            update();
        });
    });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", update);
}

