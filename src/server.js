require("dotenv").config();
require("express-async-errors"); // lets the async route handlers below throw straight into the error middleware
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
// Documents carry base64 files up to 10 MB; everything else stays at 5 MB.
app.use("/documents", express.json({ limit: "15mb" }));
app.use(express.json({ limit: "5mb" })); // bulk imports (vendor/customer lists) can exceed the 100kb default

app.get("/health", (req, res) => res.json({ ok: true, service: "yard-built-api", time: new Date().toISOString() }));

// The public marketing site (src/site) answers on yardbuilt.net / www.yardbuilt.net; everything
// else (app.yardbuilt.net, the Railway URL, localhost) gets the app. /login on the marketing host
// sends people to the app's sign-in screen.
const SITE_HOSTS = /^(www\.)?yardbuilt\.net$/i;
const siteStatic = express.static(path.join(__dirname, "site"));
app.use((req, res, next) => {
  if (!SITE_HOSTS.test(req.hostname || "")) return next();
  if (req.method === "GET" && /^\/(login|signin|sign-in|app)\/?$/i.test(req.path)) return res.redirect(302, "https://app.yardbuilt.net/");
  if (req.path.startsWith("/public/")) return next();
  siteStatic(req, res, () => res.status(404).sendFile(path.join(__dirname, "site", "index.html")));
});
app.use("/public", require("./routes/demoRequests").publicRouter);

// Serve the prototype UI (src/public/index.html) at the site root, so the app itself
// lives at the same URL as the API instead of needing a separate host.
app.use(express.static(path.join(__dirname, "public")));

app.use("/auth", require("./routes/auth"));
app.use("/users", require("./routes/users"));
app.use("/roles", require("./routes/roles"));
app.use("/commodities", require("./routes/commodities"));
app.use("/vendors", require("./routes/vendors"));
app.use("/customers", require("./routes/customers"));
app.use("/carriers", require("./routes/carriers"));
app.use("/contracts", require("./routes/contracts"));
app.use("/purchase-orders", require("./routes/purchaseOrders"));
app.use("/bank-accounts", require("./routes/bankAccounts"));
app.use("/positive-pay", require("./routes/positivePay"));
app.use("/documents", require("./routes/documents").router);
app.use("/tickets", require("./routes/tickets"));
app.use("/inventory", require("./routes/inventory"));
app.use("/remittances", require("./routes/remittances"));
app.use("/search", require("./routes/search"));
app.use("/freight", require("./routes/freight"));
app.use("/lanes", require("./routes/lanes"));
app.use("/trailers", require("./routes/trailers"));
app.use("/settings", require("./routes/settings"));
app.use("/assistant", require("./routes/assistant"));
app.use("/imports", require("./routes/imports"));
app.use("/demo-requests", require("./routes/demoRequests").adminRouter);   // bulk vendor/customer import from ScrapDragon exports // Claude-powered in-app assistant (needs ANTHROPIC_API_KEY)

// Centralized error handler — every route above is async and lets exceptions bubble up to this,
// rather than each one needing its own try/catch boilerplate for unexpected DB errors.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`yard-built-api listening on :${port}`));
