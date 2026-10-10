-- Seed accounts and initial balances for the demo bots.
INSERT INTO balances(account_id, asset, total, available, frozen) VALUES
    (1, 'CASH',       1000000, 1000000, 0),
    (1, 'STOCK:AAPL',    1000,    1000, 0),
    (1, 'STOCK:MSFT',     500,     500, 0),
    (2, 'CASH',       1000000, 1000000, 0),
    (2, 'STOCK:AAPL',     500,     500, 0),
    (2, 'STOCK:TSLA',     300,     300, 0)
ON CONFLICT (account_id, asset) DO NOTHING;
