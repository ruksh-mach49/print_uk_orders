import cron from "node-cron";
import { uk_handler } from "./print_uk2.js";
import { amazon_handler } from "./print_amazon2.js";
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200);
    res.end("OK");
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// sunday 3:00am for 8AM batch
cron.schedule(
  "0 3 * * 0",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// sunday 7:00am for 8AM batch
cron.schedule(
  "0 7 * * 0",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// monday 3:30am for 7AM batch
cron.schedule(
  "30 3 * * 1",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// monday 6:15am for 7AM batch
cron.schedule(
  "0 6 * * 1",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// tuesday-friday 6:00am for 7AM batch
cron.schedule(
  "0 6 * * 2-5",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// monday-friday 9:30am for 10AM batch
cron.schedule(
  "30 9 * * 1-5",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// monday-friday 11:30am for 12PM batch
cron.schedule(
  "30 11 * * 1-5",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// monday-friday 2:00pm for 2:30PM batch
cron.schedule(
  "0 14 * * 1-5",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);

// monday-friday 3:15pm for 3:45PM batch
cron.schedule(
  "15 15 * * 1-5",
  async () => {
    await amazon_handler();
    await uk_handler();
  },
  {
    scheduled: true,
    timezone: "Europe/London", // Ensures UK time
  },
);
