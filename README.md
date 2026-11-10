# Egzamin online z nadzorem – MVP (etap 1)

Statyczna strona (HTML + JavaScript, bez budowania). Egzamin ABCD z importem pytań z CSV,
limitami czasu, losowaniem i nadzorem kamerą działającym w przeglądarce zdającego (MediaPipe).

## Co działa
- Panel egzaminatora: import CSV z walidacją, liczba pytań, czas całkowity, czas na pytanie,
  próg zaliczenia, losowanie odpowiedzi, powrót do pytań, limit wyjść z pełnego ekranu.
- Ekran zgody (informacja RODO), test kamery, sprawdzenie przeglądarki i drugiego monitora, kalibracja głowy.
- Egzamin w pełnym ekranie, znak wodny z imieniem, podgląd kamery w rogu.
- Wykrywanie z kamery: brak twarzy, wiele twarzy, odwrócona głowa (w dół / w bok / w górę),
  telefon, książka/kartki, druga osoba, zasłonięta kamera.
- Wykrywanie w przeglądarce: przełączenie karty, utrata fokusu (z czasem), wyjście z pełnego ekranu,
  kopiuj/wklej, skróty (Ctrl+C/V/P/U, F12, narzędzia deweloperskie, PrintScreen), zmniejszenie okna,
  elementy wstrzyknięte przez rozszerzenia (np. panele AI), drugi monitor.
- Raport: wynik, wskaźnik ryzyka, oś czasu zdarzeń ze zrzutami, eksport JSON, lista prób w panelu.

## Ograniczenia MVP (naprawia etap 2)
- Wszystko jest w przeglądarce: klucz odpowiedzi jest w pliku egzaminu, a raporty zapisują się
  tylko na komputerze zdającego (localStorage) lub do pobrania jako JSON. Do prawdziwych egzaminów
  potrzebny jest serwer (Supabase) – ocenianie, zegar i raporty po stronie serwera.
- Progi detekcji są startowe – trzeba je dostroić na pilotażu (plik `proctor.js`, stałe na górze).

## Uruchomienie lokalnie (Mac)
```
cd egzamin-mvp
python3 -m http.server 8000
```
Otwórz http://localhost:8000 w Chrome. `localhost` jest traktowany jak HTTPS, więc kamera działa.

## Publikacja z HTTPS (bez kupowania domeny)
1. Utwórz repozytorium na GitHubie i wrzuć zawartość tego folderu.
2. Na vercel.com: Add New → Project → wybierz repozytorium → Deploy (bez ustawień, to statyczna strona).
3. Strona działa pod `https://<nazwa>.vercel.app` z darmowym certyfikatem.
   Alternatywa: Cloudflare Pages (Workers & Pages → Create → Pages → Connect to Git).

## Własny egzamin na serwerze
W panelu egzaminatora wgraj CSV, ustaw parametry i kliknij „Pobierz egzamin.json”.
Wrzuć `egzamin.json` obok `index.html` – strona użyje go automatycznie.

## Format CSV
```
pytanie;a;b;c;d;poprawna;kategoria;punkty
Ile wynosi 7 × 8?;54;56;58;64;B;matematyka;1
```
Separator `;` lub `,`, kodowanie UTF-8, pola z separatorem w cudzysłowie `"..."`.

## Pliki
- `index.html`, `style.css` – interfejs
- `app.js` – panel, CSV, przebieg egzaminu, zdarzenia przeglądarki, raporty
- `proctor.js` – analiza kamery (MediaPipe Face Landmarker + Object Detector EfficientDet-Lite0)
- `przyklad.csv` – przykładowe pytania
- `vercel.json` – nagłówki bezpieczeństwa
