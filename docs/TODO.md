# TODO — Mezodot Protocol Frontend

## 1. Shell dApp, navigasi, dan status simulasi

- [x] Bangun antarmuka responsif desktop/mobile dengan navigasi lengkap untuk Dashboard, Markets/Vaults, Cross-chain, Borrow, Loop, Agents/Risk, Architecture, dan Activity.
- [x] Tampilkan wallet/network mock state dan CTA, forms, modals, notifications, tabs/sections yang berfungsi, serta validasi dasar jumlah.
- [x] Semua saldo, metric pasar, posisi, hasil risk, chain event, dan status transaksi harus secara jelas bertanda data simulasi/dummy, bukan data live/on-chain.
- [x] Jangan mengklaim smart contract, wallet connectivity, ataupun eksekusi Wormhole yang berfungsi.

## 2. Dashboard pasar dan posisi

- [x] Prioritaskan 1-Click Loop dan Cross-chain Collateral pada dashboard.
- [x] Tampilkan KPI TVL, looping volume, agent participation, dan cross-chain borrowing ratio dengan angka dummy yang konsisten di seluruh aplikasi.
- [x] Tampilkan ringkasan pasar MUSD/MEZO, posisi pengguna, dan vault health menggunakan model data simulasi bersama.

## 3. Pasar pinjaman dan pToken ERC-4626

- [x] Sediakan alur supply dan withdraw untuk MUSD serta MEZO; preview mint/redeem pMUSD/pMEZO sebagai receipt token gaya ERC-4626.
- [x] Perlihatkan exchange rate pToken terhadap aset dasar meningkat melalui bunga borrower dalam simulasi.
- [x] Sertakan skenario LP deposit 10,000 MUSD dan menerima pMUSD.

## 4. Collateral lintas-chain Hub & Spoke

- [x] Sediakan pemilih source chain/asset, deposit mock wETH melalui SpokeGateway, langkah konfirmasi, tahapan pesan WormholeAdapter, dan status simulasi.
- [x] Pertahankan perbedaan sumber collateral pada external Spoke (misalnya Arbitrum/Ethereum) dan pusat accounting/borrowing pada Mezo Hub; dukung contoh Arbitrum ke Mezo.
- [x] Perlihatkan pesan lintas-chain dan hasilnya sebagai simulasi tanpa menyatakan bahwa Wormhole live.

## 5. Borrow dan risiko posisi

- [x] Sediakan antarmuka pinjaman MUSD yang menghitung jumlah tersedia dari collateral lintas-chain secara mock.
- [x] Tampilkan LTV, health factor, likuiditas tersedia, rate, estimasi liquidation, validasi, dan warning states secara konsisten.
- [x] Jelaskan VaultManager sebagai sumber state pengguna, batas LTV, dan health factor global lintas-chain.

## 6. Leverage/loop satu klik

- [x] Sediakan konfigurator looping untuk collateral, leverage, borrow, net APY, estimasi liquidation price, serta hasil proyeksi.
- [x] Dukung skenario 1,000 MUSD dengan Loop 3x dan jejak transaksi simulasi: flash borrow MUSD → supply → borrow → repay dalam satu transaksi.
- [x] Tandai jejak transaksi LeverageManager sebagai simulasi, bukan eksekusi nyata.

## 7. Agent, MCP, dan quantitative risk

- [x] Tampilkan status KeeperGateway, aktivitas liquidation/rebalance, volatility, backtest, DSR, walk-forward results, dan risk alerts sebagai simulasi.
- [x] Tampilkan kesiapan endpoint/API MCP/agent tanpa menyiratkan automation live.
- [x] Jelaskan bahwa agent dapat mengelola liquidation/rebalance dan mengonsumsi data risk hanya sebagai konsep/prototipe UI.

## 8. Arsitektur protokol

- [x] Sajikan diagram/penjelasan pemisahan Mezo Hub dan external Spokes serta alur Wormhole messaging.
- [x] Petakan VaultManager (state/LTV/health factor), MezodotPool (likuiditas/rates), pToken (ERC-4626), WormholeAdapter (pesan), LeverageManager (flash-loan looping), dan KeeperGateway (keeper) ke bagian arsitektur yang benar.
- [x] Jelaskan bagaimana MUSD/MEZO menjadi modal produktif, serta sifat komposabel dari pMUSD/pMEZO, tanpa mengklaim deployment nyata.

## 9. Activity dan histori

- [x] Sediakan histori/filter catatan supply, withdraw, cross-chain messages, borrows, loops, liquidations, dan rebalances.
- [x] Tampilkan detail modal, status, transaction-style identifiers, dan tautan kembali ke posisi yang semuanya merupakan dummy konsisten.

## 10. Model data terpadu dan koherensi skenario

- [x] Gunakan sumber mock bersama untuk pasar, saldo, posisi, exchange rates, APY, collateral, health factor, risk metrics, pesan chain, status arsitektur, dan hasil transaksi.
- [x] Jaga koherensi numerik dan keterkaitan data untuk contoh LP deposit 10,000 MUSD, peminjam wETH Arbitrum yang pinjam MUSD di Mezo, dan loop 1,000 MUSD pada 3x.
