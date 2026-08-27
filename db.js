const { PrismaClient } = require("@prisma/client");

const rawUrl = process.env.DATABASE_URL || "";
const cleanUrl = rawUrl.replace(/^["']|["']$/g, "").trim();

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: cleanUrl,
    },
  },
});

module.exports = prisma;
