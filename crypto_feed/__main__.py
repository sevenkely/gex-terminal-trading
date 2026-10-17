"""`python -m crypto_feed` → même chose que `python -m crypto_feed.main`."""
from .main import main

if __name__ == "__main__":
    raise SystemExit(main())
