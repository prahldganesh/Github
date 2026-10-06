/**
 * Seed the catalogue.
 *
 * Run with `npm run db:seed`. Idempotent: it upserts by slug, so re-running
 * updates these rows rather than duplicating them.
 *
 * This is the catalogue for **Adambakkam Sri Srinivasa Boli Stall**, so the
 * products are what the stall actually sells - boli first, as it should be,
 * then the savouries and other sweets a Chennai sweet stall keeps.
 *
 * Prices are written as integer paise. The comment beside each one shows the
 * rupee value it represents, because reading `3500` at a glance is how money
 * bugs get introduced.
 *
 * The trailing entry is deliberately INACTIVE. It exists so the "disabled
 * product is hidden from the catalogue and 404s on its detail page" behaviour
 * has something to act on, and because a seasonal sweet genuinely is unavailable
 * out of season - which is a truer reason than a placeholder test row.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";

const adapter = new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) });
const prisma = new PrismaClient({ adapter });

const products = [
  {
    name: "Adambakkam Boli",
    slug: "adambakkam-boli",
    description:
      "Our boli: a thin, ghee-brushed flatbread folded around a soft chana dal and jaggery filling. Made fresh each morning and sold by the piece, which is how it is best eaten - warm, within the day.",
    price: 3500, // Rs.35.00
    stock: 120,
    active: true,
  },
  {
    name: "Boli Box (6 pieces)",
    slug: "boli-box-six",
    description:
      "Six pieces of our boli in a box, packed for carrying. The box is what most people take when they are visiting someone - it travels better than loose pieces.",
    price: 20000, // Rs.200.00
    stock: 30,
    active: true,
  },
  {
    name: "Murukku, 250 g",
    slug: "murukku-250g",
    description:
      "Crisp, coiled murukku made with rice flour and sesame. Fried in small batches so it stays light, and sold by weight.",
    price: 12000, // Rs.120.00
    stock: 40,
    active: true,
  },
  {
    name: "Kaara Mixture, 250 g",
    slug: "kaara-mixture-250g",
    description:
      "The savoury mixture - boondi, peanuts, fried curry leaves, sev and a little heat. The thing that disappears first at any gathering.",
    price: 10000, // Rs.100.00
    stock: 45,
    active: true,
  },
  {
    name: "Boondi Laddu (6 pieces)",
    slug: "boondi-laddu-six",
    description:
      "Soft boondi laddus rolled by hand, heavy with ghee and studded with cashew. Sold by the half dozen.",
    price: 15000, // Rs.150.00
    stock: 30,
    active: true,
  },
  {
    name: "Jangiri (6 pieces)",
    slug: "jangiri-six",
    description:
      "Urad dal jangiri, soaked in saffron sugar syrup until it is the colour of a marigold. Sweet, and unapologetically so.",
    price: 15000, // Rs.150.00
    stock: 24,
    active: true,
  },
  {
    name: "Mysore Pak, 250 g",
    slug: "mysore-pak-250g",
    description:
      "The proper kind, made with gram flour and a great deal of ghee. It should melt rather than crumble, and this one does.",
    price: 18000, // Rs.180.00
    stock: 18,
    active: true,
  },
  {
    name: "Rava Laddu (6 pieces)",
    slug: "rava-laddu-six",
    description:
      "Roasted rava laddus with cardamom, coconut and cashew. Keeps well, travels well, and is usually the second box people buy.",
    price: 13000, // Rs.130.00
    stock: 28,
    active: true,
  },
  {
    // INACTIVE on purpose. Shown in the admin list, hidden from the storefront,
    // and its detail page 404s - which is the behaviour the checks rely on.
    name: "Karthigai Adhirasam (seasonal)",
    slug: "karthigai-adhirasam-seasonal",
    description:
      "Made for Karthigai Deepam and a little either side of it. Available seasonally - it is off the shelf the rest of the year, so you will usually see this page outside the festival.",
    price: 4000, // Rs.40.00
    stock: 0,
    active: false,
  },
];

/**
 * Slugs from the original demo catalogue, removed here.
 *
 * The seed only upserts, so without this the old demo rows would linger in any
 * database seeded before the shop's real products existed. They are named
 * explicitly rather than "delete everything not in the list", because a blanket
 * delete would destroy products the owner added by hand.
 *
 * Deleting a product does NOT damage order history: `order_items` store a
 * snapshot of the product name and price and their foreign key is
 * `ON DELETE SET NULL`, so old orders keep reading correctly (ADR/CONTEXT
 * "Snapshot").
 */
const legacyDemoSlugs = [
  "cold-pressed-coconut-oil",
  "organic-turmeric-powder",
  "handmade-neem-soap",
  "wild-forest-honey",
  "discontinued-sample-item",
];

async function main() {
  for (const product of products) {
    await prisma.product.upsert({
      where: { slug: product.slug },
      update: product,
      create: product,
    });
  }

  const removed = await prisma.product.deleteMany({
    where: { slug: { in: legacyDemoSlugs } },
  });

  const total = await prisma.product.count();
  const active = await prisma.product.count({ where: { active: true } });
  console.log(
    `Seeded ${products.length} products (${active} active, ${total - active} inactive).` +
      (removed.count > 0 ? ` Removed ${removed.count} demo product(s).` : ""),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
