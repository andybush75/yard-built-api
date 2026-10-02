require("dotenv").config();
require("express-async-errors"); // lets the async route handlers below throw straight into the error middleware
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "yard-built-api", time: new Date().toISOString() }));

// Serve the prototype UI (public/index.html) at the site root, so the app itself
// lives at the same URL as the API instead of needing a separate host.
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/auth", require("./routes/auth"));
app.use("/commodities", require("./routes/commodities"));
app.use("/vendors", require("./routes/vendors"));
app.use("/customers", require("./routes/customers"));
app.use("/carriers", require("./routes/carriers"));
app.use("/contracts", require("./routes/contracts"));
app.use("/purchase-orders", require("./routes/purchaseOrders"));
app.use("/bank-accounts", require("./routes/bankAccounts"));
app.use("/tickets", require("./routes/tickets"));
app.use("/inventory", require("./routes/inventory"));
app.use("/remittances", require("./routes/remittances"));

// Centralized error handler — every route above is async and lets exceptions bubble up to this,
// rather than each one needing its own try/catch boilerplate for unexpected DB errors.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`yard-built-api listening on :${port}`));
