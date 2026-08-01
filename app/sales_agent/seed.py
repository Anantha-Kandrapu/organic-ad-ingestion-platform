from __future__ import annotations

from .db import SessionLocal
from .models import Customer, Inventory, Offer, Product

# (sku, name, category, unit, base_price, description, [offers], stock)
# offer = (name, min_qty, unit_price, discount_pct)
_PRODUCTS = [
    (
        "BV-COLA-24",
        "Cola Classic 330ml",
        "Beverages",
        "case of 24",
        14.40,
        "Case of 24 cans of classic cola.",
        [("Pallet deal 50+", 50, 12.50, 13.2), ("Bulk 20+", 20, 13.20, 8.3)],
        320,
    ),
    (
        "BV-WATER-12",
        "Spring Water 1L",
        "Beverages",
        "case of 12",
        6.00,
        "Case of 12 x 1L still spring water.",
        [("Bulk 40+", 40, 5.10, 15.0)],
        900,
    ),
    (
        "SN-CHIP-30",
        "Potato Chips Salted 50g",
        "Snacks",
        "box of 30",
        21.00,
        "Box of 30 x 50g salted potato chips.",
        [("Bulk 25+", 25, 18.90, 10.0)],
        140,
    ),
    (
        "SN-NUTS-20",
        "Mixed Nuts 100g",
        "Snacks",
        "box of 20",
        30.00,
        "Box of 20 x 100g roasted mixed nuts.",
        [("Bulk 15+", 15, 27.00, 10.0)],
        60,
    ),
    (
        "DA-MILK-12",
        "Whole Milk 1L UHT",
        "Dairy",
        "case of 12",
        11.40,
        "Case of 12 x 1L UHT whole milk, long life.",
        [("Pallet 60+", 60, 9.60, 15.8)],
        410,
    ),
    (
        "DA-CHEE-10",
        "Cheddar Block 500g",
        "Dairy",
        "box of 10",
        45.00,
        "Box of 10 x 500g mature cheddar blocks.",
        [("Bulk 12+", 12, 40.50, 10.0)],
        35,
    ),
    (
        "GR-RICE-25",
        "Basmati Rice 5kg",
        "Grains",
        "bag",
        18.00,
        "5kg bag of premium basmati rice.",
        [("Pallet 100+", 100, 15.30, 15.0)],
        220,
    ),
]

_CUSTOMERS = [
    ("Ravi Patel", "Corner Mart Wholesale", "wholesale", "+1-555-0101", "ravi@cornermart.example"),
    ("Lena Ortiz", "Sunrise Grocers", "wholesale", "+1-555-0102", "lena@sunrise.example"),
]


def seed_if_empty() -> None:
    with SessionLocal() as db:
        if db.query(Product).count() > 0:
            return

        for name, company, segment, phone, email in _CUSTOMERS:
            db.add(Customer(name=name, company=company, segment=segment, phone=phone, email=email))

        for sku, name, cat, unit, price, desc, offers, stock in _PRODUCTS:
            product = Product(
                sku=sku,
                name=name,
                category=cat,
                unit=unit,
                base_price=price,
                description=desc,
            )
            db.add(product)
            db.flush()  # assign product.id
            for oname, minq, uprice, disc in offers:
                db.add(
                    Offer(
                        product_id=product.id,
                        name=oname,
                        min_quantity=minq,
                        unit_price=uprice,
                        discount_pct=disc,
                        valid_until="2026-12-31",
                    )
                )
            db.add(
                Inventory(product_id=product.id, warehouse="Main", quantity_available=stock)
            )

        db.commit()
