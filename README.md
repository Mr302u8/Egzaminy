# Egzamin online z nadzorem – MVP (etap 1)

Statyczna strona (HTML + JavaScript, bez budowania). Egzamin ABCD z importem pytań z CSV,
limitami czasu, losowaniem i nadzorem kamerą działającym w przeglądarce zdającego (MediaPipe).

## Co działa
- Panel egzaminatora: import CSV z walidacją, liczba pytań, czas całkowity, czas na pytanie,
  próg zaliczenia, losowanie odpowiedzi, powrót do pytań, limit wyjść z pełnego ekranu.
- Ekran zgody (informacja RODO), test kamery, sprawdzenie przeglądarki i drugiego monitora, kalibracja głowy.
- Egzamin w pełnym ekranie, znak wodny z imieniem, podgląd kamery w rogu.
- Wykrywanie z kamery: brak twarzy, wiele twarzy, patrzenie w dół / w bok / w górę (ruch głowy
  ORAZ ruch samych oczu – blendshapes MediaPipe), telefon, książka/kartki, druga osoba,
  zasłonięta lub zamrożona kamera. Model przedmiotów EfficientDet-Lite2, a na wolnych
  komputerach automatycznie Lite0.
- Tryb „tylko klawiatura” (domyślnie włączony): odpowiedzi 1–4 lub A–D, Enter = dalej,
  kursor ukryty i zablokowany w oknie (Pointer Lock), kliknięcia ignorowane, odblokowanie myszki
  jest zapisywane jako zdarzenie.
- Śledzenie źrenic (punkty tęczówek 468–477 z MediaPipe Face Landmarker) i kątów głowy
  (macierz transformacji twarzy), kamera w 720p. Przed egzaminem kalibracja wzroku na 5 punktach
  ekranu (środek + rogi): wyznacza osobisty zakres „patrzę w ekran”, a spojrzenie poza niego
  (+ margines z `MARGINS` w `proctor.js`) jest zdarzeniem. Wykrywanie odsunięcia/przesunięcia twarzy.
- Patrzenie w dół na telefon na kolanach / klawiaturze: także z opuszczenia powiek (otwarcie oka
  spada przy patrzeniu w dół) – działa, nawet gdy telefonu nie widać w kadrze.
- Osobne zdarzenia „w lewo” i „w prawo” (z perspektywy zdającego), ruch ust (mówienie/szeptanie),
  analiza ok. 6–7 razy na sekundę z wygładzaniem (pojedyncze klatki nie gubią zdarzeń).
- Każda kamera: próby 720p → 480p → dowolna rozdzielczość, wybór kamery (wbudowana/USB),
  obliczenia w pikselach (4:3, 16:9), ocena jakości obrazu (światło na twarzy, rozmiar oka w px)
  z jasnym komunikatem; przy małej rozdzielczości źrenice są pomijane, działa śledzenie głowy.
- Podgląd śledzenia: kadr przybliżony na twarz z zaznaczonymi oczami i źrenicami
  (zielone = patrzy w ekran, czerwone = poza ekran).
- Zdjęcie startowe w raporcie + oświadczenie o braku okularów/słuchawek z kamerą.
- Tryb diagnostyczny: dodaj `?debug=1` do adresu – pod podglądem kamery widać na żywo
  liczbę twarzy, kierunek wzroku, wartości i pewność wykrycia telefonu.
- Wykrywanie w przeglądarce: przełączenie karty, utrata fokusu (z czasem), wyjście z pełnego ekranu,
  kopiuj/wklej, skróty (Ctrl+C/V/P/U, F12, narzędzia deweloperskie, PrintScreen), zmniejszenie okna,
  elementy wstrzyknięte przez rozszerzenia (np. panele AI), drugi monitor.
- Raport: wynik, wskaźnik ryzyka, oś czasu zdarzeń ze zrzutami, eksport JSON, lista prób w panelu.

## Ograniczenia MVP (naprawia etap 2)
- Wszystko jest w przeglądarce: klucz odpowiedzi jest w pliku egzaminu, a raporty zapisują się
  tylko na komputerze zdającego (localStorage) lub do pobrania jako JSON. Do prawdziwych egzaminów
  potrzebny jest serwer (Supabase) – ocenianie, zegar i raporty po stronie serwera.
- Progi detekcji są startowe – trzeba je dostroić na pilotażu (plik `proctor.js`, `RULES` i `LIMITS` na górze).

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
