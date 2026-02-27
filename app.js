/* ============================================
   FitTrack - AI-Powered Spor & Kalori Takibi
   Gemini API for food analysis + macro tracking
   ============================================ */

(function () {
    'use strict';
    console.log('FitTrack app.js loading...');

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    function todayStr() { return new Date().toISOString().slice(0, 10); }

    function formatDate(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function formatDateShort(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    }

    function showToast(message, isError = false) {
        const toast = $('#toast');
        toast.textContent = message;
        toast.className = 'toast' + (isError ? ' error' : '');
        toast.classList.add('show');
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }

    // ========== DATA STORE ==========
    const Store = {
        _get(key, fallback) {
            try {
                const val = localStorage.getItem('fittrack_' + key);
                return val ? JSON.parse(val) : fallback;
            } catch { return fallback; }
        },
        _set(key, val) { localStorage.setItem('fittrack_' + key, JSON.stringify(val)); },

        // Workouts
        getWorkouts() { return this._get('workouts', []); },
        setWorkouts(arr) { this._set('workouts', arr); },
        addWorkout(entry) {
            const list = this.getWorkouts();
            list.push(entry);
            list.sort((a, b) => a.date.localeCompare(b.date));
            this.setWorkouts(list);
        },
        deleteWorkout(id) { this.setWorkouts(this.getWorkouts().filter(w => w.id !== id)); },

        // Meals: { id, date, name, calories, protein, carbs, fat, mealTime }
        getMeals() { return this._get('meals', []); },
        setMeals(arr) { this._set('meals', arr); },
        addMeal(entry) { const list = this.getMeals(); list.push(entry); this.setMeals(list); },
        deleteMeal(id) { this.setMeals(this.getMeals().filter(m => m.id !== id)); },

        // Profile
        getProfile() {
            return this._get('profile', { height: 175, age: 25, bodyWeight: 75, calorieGoal: 2000 });
        },
        setProfile(p) { this._set('profile', p); },

        // API Key
        getApiKey() {
            const key = localStorage.getItem('fittrack_gemini_key') || '';
            return key ? key.trim() : '';
        },
        setApiKey(key) { localStorage.setItem('fittrack_gemini_key', key); },

        getUsedExercises() {
            return [...new Set(this.getWorkouts().map(w => w.exercise))].sort();
        },

        getPersonalRecords() {
            const prMap = {};
            const workouts = this.getWorkouts();
            if (!Array.isArray(workouts)) return prMap;
            workouts.forEach(w => {
                if (w && w.exercise && (!prMap[w.exercise] || w.weight > prMap[w.exercise].weight)) {
                    prMap[w.exercise] = { weight: w.weight, sets: w.sets, reps: w.reps, date: w.date };
                }
            });
            return prMap;
        },

        clearAll() {
            ['workouts', 'meals', 'profile', 'food_cache', 'programs', 'programLogs'].forEach(k => localStorage.removeItem('fittrack_' + k));
            localStorage.removeItem('fittrack_gemini_key');
        },

        // Training Programs
        getPrograms() {
            const oldProgram = this._get('program', null);
            let programs = this._get('programs', null);

            if (!programs) {
                const defaultId = generateId();
                programs = {
                    currentId: defaultId,
                    items: [{ id: defaultId, name: 'Program 1', exercises: oldProgram || [] }]
                };
                this.setPrograms(programs);
                if (oldProgram) localStorage.removeItem('fittrack_program');
            }
            return programs;
        },
        setPrograms(obj) { this._set('programs', obj); },
        getCurrentProgram() {
            const data = this.getPrograms();
            return data.items.find(p => p.id === data.currentId) || data.items[0];
        },
        addProgram(name) {
            const data = this.getPrograms();
            const newId = generateId();
            data.items.push({ id: newId, name: name || `Program ${data.items.length + 1}`, exercises: [], day: '' });
            data.currentId = newId;
            this.setPrograms(data);
            return newId;
        },
        updateProgramDay(id, day) {
            const data = this.getPrograms();
            const prog = data.items.find(p => p.id === id);
            if (prog) {
                prog.day = day;
                this.setPrograms(data);
            }
        },
        deleteProgram(id) {
            const data = this.getPrograms();
            if (data.items.length <= 1) return;
            data.items = data.items.filter(p => p.id !== id);
            if (data.currentId === id) data.currentId = data.items[0].id;
            this.setPrograms(data);
        },
        switchProgram(id) {
            const data = this.getPrograms();
            if (data.items.find(p => p.id === id)) {
                data.currentId = id;
                this.setPrograms(data);
            }
        },

        async callGemini(prompt, inlineData = null) {
            const apiKey = this.getApiKey();
            if (!apiKey) throw new Error('Gemini API anahtarı bulunamadı.');

            let response = null;
            let lastError = null;

            // Prepare payload
            const parts = [{ text: prompt }];
            if (inlineData) parts.push({ inlineData });
            const body = {
                contents: [{ parts }],
                generationConfig: { temperature: 0.1 }
            };

            // Step 1: Try common models
            const primaryModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];
            const versions = ['v1', 'v1beta'];

            for (const ver of versions) {
                for (const model of primaryModels) {
                    const url = `https://generativelanguage.googleapis.com/${ver}/models/${model}:generateContent?key=${apiKey}`;
                    try {
                        console.log(`[FitTrack] Trying AI: ${ver}/${model}`);
                        const tryRes = await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        });
                        if (tryRes.ok) {
                            response = tryRes;
                            break;
                        }
                        const err = await tryRes.json().catch(() => ({}));
                        lastError = err?.error?.message || tryRes.statusText;
                    } catch (e) { lastError = e.message; }
                }
                if (response && response.ok) break;
            }

            // Step 2: Auto-discovery fallback
            if (!response || !response.ok) {
                console.warn('[FitTrack] Fallback: Model discovery starting...');
                try {
                    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
                    const listRes = await fetch(listUrl);
                    if (listRes.ok) {
                        const listData = await listRes.json();
                        const availableModels = (listData.models || [])
                            .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                            .map(m => m.name);

                        for (const fullModelName of availableModels) {
                            if (fullModelName.includes('gemini')) {
                                try {
                                    console.log(`[FitTrack] Trying Discovered AI: ${fullModelName}`);
                                    const url = `https://generativelanguage.googleapis.com/v1beta/${fullModelName}:generateContent?key=${apiKey}`;
                                    const discRes = await fetch(url, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify(body)
                                    });
                                    if (discRes.ok) {
                                        response = discRes;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                } catch (e) { console.error('[FitTrack] Discovery failed:', e); }
            }

            if (!response || !response.ok) {
                throw new Error(lastError || 'Uygun AI modeli bulunamadı. Lütfen API anahtarını kontrol edin.');
            }

            return await response.json();
        },

        // Exercise methods (per current program)
        getProgramExercises() { return this.getCurrentProgram().exercises; },
        addProgramExercise(entry) {
            const data = this.getPrograms();
            const prog = data.items.find(p => p.id === data.currentId);
            prog.exercises.push(entry);
            this.setPrograms(data);
        },
        deleteProgramExercise(id) {
            const data = this.getPrograms();
            const prog = data.items.find(p => p.id === data.currentId);
            prog.exercises = prog.exercises.filter(e => e.id !== id);
            this.setPrograms(data);
        },

        // Program Logs
        getProgramLogs() { return this._get('programLogs', []); },
        setProgramLogs(arr) { this._set('programLogs', arr); },
        addProgramLog(entry) { const list = this.getProgramLogs(); list.push(entry); this.setProgramLogs(list); },
        deleteProgramLog(id) { this.setProgramLogs(this.getProgramLogs().filter(l => l.id !== id)); },

        // AI Food Cache
        getFoodCache() {
            return JSON.parse(localStorage.getItem('fittrack_food_cache') || '{}');
        },
        cacheFoodResult(query, result) {
            const cache = this.getFoodCache();
            const key = query.toLowerCase().trim();
            cache[key] = { ...result, cachedAt: new Date().toISOString() };
            localStorage.setItem('fittrack_food_cache', JSON.stringify(cache));
        },
        getCachedFood(query) {
            const cache = this.getFoodCache();
            return cache[query.toLowerCase().trim()] || null;
        },

        exportData() {
            return JSON.stringify({
                workouts: this.getWorkouts(), meals: this.getMeals(),
                profile: this.getProfile(), exportedAt: new Date().toISOString()
            }, null, 2);
        }
    };

    // ========== TURKISH FOOD DATABASE ==========
    // 1 porsiyon bazında besin değerleri (kcal, protein g, karb g, yağ g)
    const FOOD_DB = [
        // --- Et & Tavuk ---
        { keys: ['tavuk göğsü', 'tavuk gogsu', 'chicken breast'], name: 'Haşlanmış Tavuk Göğsü (200g)', cal: 330, p: 62, c: 0, f: 7, per100g: { cal: 165, p: 31, c: 0, f: 3.6 } },
        { keys: ['tavuk but', 'chicken thigh'], name: 'Tavuk But (150g)', cal: 285, p: 38, c: 0, f: 14, per100g: { cal: 190, p: 25, c: 0, f: 9.5 } },
        { keys: ['tavuk kanat', 'chicken wing'], name: 'Tavuk Kanat (100g)', cal: 203, p: 18, c: 0, f: 14 },
        { keys: ['köfte', 'kofte', 'meatball'], name: 'Izgara Köfte (4 tane)', cal: 340, p: 28, c: 5, f: 23 },
        { keys: ['et sote', 'sote', 'beef stew'], name: 'Et Sote (1 porsiyon)', cal: 350, p: 30, c: 10, f: 21 },
        { keys: ['döner', 'doner', 'kebab döner'], name: 'Döner (1 porsiyon)', cal: 450, p: 28, c: 35, f: 22 },
        { keys: ['adana kebap', 'adana'], name: 'Adana Kebap (1 porsiyon)', cal: 400, p: 25, c: 5, f: 32 },
        { keys: ['urfa kebap', 'urfa'], name: 'Urfa Kebap (1 porsiyon)', cal: 380, p: 24, c: 5, f: 30 },
        { keys: ['iskender', 'iskender kebap'], name: 'İskender Kebap', cal: 650, p: 35, c: 40, f: 38 },
        { keys: ['lahmacun'], name: 'Lahmacun (1 tane)', cal: 210, p: 10, c: 25, f: 8 },
        { keys: ['pide', 'kaşarlı pide', 'kasarli pide'], name: 'Kaşarlı Pide (1 dilim)', cal: 280, p: 12, c: 30, f: 13 },
        { keys: ['kuşbaşı', 'kusbasi', 'kuşbaşı et'], name: 'Kuşbaşı Et (1 porsiyon)', cal: 300, p: 32, c: 3, f: 18 },
        { keys: ['biftek', 'steak'], name: 'Biftek (200g)', cal: 370, p: 50, c: 0, f: 18 },
        { keys: ['sucuk', 'sucuklu yumurta'], name: 'Sucuk (4 dilim)', cal: 200, p: 10, c: 1, f: 17 },
        { keys: ['balık', 'balik', 'levrek', 'çupra', 'hamsi', 'fish'], name: 'Izgara Balık (200g)', cal: 220, p: 40, c: 0, f: 6 },

        // --- Pilav & Makarna ---
        { keys: ['pilav', 'pirinç pilavı', 'pirinc pilavi', 'rice'], name: 'Pirinç Pilavı (1 porsiyon)', cal: 210, p: 4, c: 44, f: 2 },
        { keys: ['bulgur pilavı', 'bulgur pilavi', 'bulgur'], name: 'Bulgur Pilavı (1 porsiyon)', cal: 185, p: 6, c: 38, f: 2 },
        { keys: ['makarna', 'spagetti', 'pasta'], name: 'Makarna (1 porsiyon)', cal: 280, p: 10, c: 50, f: 5 },
        { keys: ['noodle', 'erişte', 'eriste'], name: 'Erişte (1 porsiyon)', cal: 260, p: 8, c: 45, f: 5 },
        { keys: ['mantı', 'manti'], name: 'Mantı (1 porsiyon)', cal: 350, p: 15, c: 42, f: 14 },

        // --- Çorbalar ---
        { keys: ['mercimek çorbası', 'mercimek corbasi', 'mercimek', 'lentil soup'], name: 'Mercimek Çorbası (1 kase)', cal: 150, p: 9, c: 22, f: 3 },
        { keys: ['ezogelin çorbası', 'ezogelin', 'ezogelin corbasi'], name: 'Ezogelin Çorbası (1 kase)', cal: 140, p: 7, c: 22, f: 3 },
        { keys: ['domates çorbası', 'domates corbasi'], name: 'Domates Çorbası (1 kase)', cal: 120, p: 3, c: 18, f: 4 },
        { keys: ['tavuk çorbası', 'tavuk suyu', 'chicken soup'], name: 'Tavuk Çorbası (1 kase)', cal: 130, p: 10, c: 12, f: 5 },
        { keys: ['işkembe', 'iskembe'], name: 'İşkembe Çorbası (1 kase)', cal: 180, p: 14, c: 8, f: 10 },
        { keys: ['yayla çorbası', 'yayla'], name: 'Yayla Çorbası (1 kase)', cal: 130, p: 5, c: 14, f: 6 },
        { keys: ['tarhana', 'tarhana çorbası'], name: 'Tarhana Çorbası (1 kase)', cal: 135, p: 5, c: 20, f: 4 },

        // --- Sebze Yemekleri ---
        { keys: ['kuru fasulye', 'fasulye', 'white beans'], name: 'Kuru Fasulye (1 porsiyon)', cal: 200, p: 12, c: 30, f: 4 },
        { keys: ['nohut', 'chickpea', 'nohut yemeği'], name: 'Nohut Yemeği (1 porsiyon)', cal: 210, p: 11, c: 32, f: 5 },
        { keys: ['karnıyarık', 'karniyarik'], name: 'Karnıyarık (2 tane)', cal: 380, p: 15, c: 20, f: 28 },
        { keys: ['imam bayıldı', 'imam bayildi', 'imambayıldı'], name: 'İmam Bayıldı (2 tane)', cal: 280, p: 5, c: 18, f: 22 },
        { keys: ['dolma', 'yaprak sarma', 'sarma'], name: 'Yaprak Sarma (6 tane)', cal: 250, p: 6, c: 30, f: 12 },
        { keys: ['menemen'], name: 'Menemen (1 porsiyon)', cal: 220, p: 12, c: 10, f: 16 },
        { keys: ['patlıcan musakka', 'musakka'], name: 'Musakka (1 porsiyon)', cal: 320, p: 14, c: 18, f: 22 },
        { keys: ['türlü', 'turlu'], name: 'Türlü (1 porsiyon)', cal: 180, p: 6, c: 20, f: 9 },
        { keys: ['zeytinyağlı fasulye', 'taze fasulye'], name: 'Zeytinyağlı Fasulye (1 porsiyon)', cal: 150, p: 4, c: 15, f: 9 },
        { keys: ['bamya'], name: 'Bamya Yemeği (1 porsiyon)', cal: 170, p: 6, c: 14, f: 10 },

        // --- Börek & Hamurişi ---
        { keys: ['börek', 'borek', 'su böreği', 'su boregi'], name: 'Su Böreği (1 dilim)', cal: 300, p: 12, c: 28, f: 16 },
        { keys: ['sigara böreği', 'sigara boregi'], name: 'Sigara Böreği (3 tane)', cal: 270, p: 10, c: 24, f: 15 },
        { keys: ['gözleme', 'gozleme'], name: 'Gözleme (1 tane)', cal: 350, p: 12, c: 40, f: 16 },
        { keys: ['simit'], name: 'Simit (1 tane)', cal: 280, p: 9, c: 48, f: 6 },
        { keys: ['poğaça', 'pogaca', 'peynirli poğaça'], name: 'Poğaça (1 tane)', cal: 250, p: 6, c: 30, f: 12 },
        { keys: ['açma', 'acma'], name: 'Açma (1 tane)', cal: 260, p: 5, c: 32, f: 13 },
        { keys: ['ekmek', 'bread'], name: 'Ekmek (1 dilim)', cal: 75, p: 3, c: 14, f: 1 },
        { keys: ['pita', 'pide ekmek', 'bazlama'], name: 'Bazlama (1 tane)', cal: 220, p: 6, c: 40, f: 4 },
        { keys: ['pizza'], name: 'Pizza (1 dilim)', cal: 270, p: 11, c: 30, f: 12 },
        { keys: ['tost', 'toast', 'kaşarlı tost'], name: 'Kaşarlı Tost', cal: 310, p: 14, c: 28, f: 16 },
        { keys: ['hamburger', 'burger'], name: 'Hamburger', cal: 500, p: 25, c: 40, f: 26 },

        // --- Kahvaltılık ---
        { keys: ['yumurta', 'haşlanmış yumurta', 'egg'], name: 'Yumurta (1 tane)', cal: 78, p: 6, c: 1, f: 5 },
        { keys: ['omlet', 'omelette'], name: 'Omlet (2 yumurta)', cal: 220, p: 14, c: 2, f: 17 },
        { keys: ['sahanda yumurta', 'yumurta sahanda'], name: 'Sahanda Yumurta (2 tane)', cal: 240, p: 13, c: 2, f: 20 },
        { keys: ['peynir', 'beyaz peynir', 'cheese'], name: 'Beyaz Peynir (50g)', cal: 130, p: 9, c: 1, f: 10 },
        { keys: ['kaşar', 'kasar', 'kaşar peynir'], name: 'Kaşar Peyniri (30g)', cal: 110, p: 7, c: 0, f: 9 },
        { keys: ['zeytin', 'olive'], name: 'Zeytin (10 tane)', cal: 60, p: 0, c: 2, f: 6 },
        { keys: ['bal', 'honey'], name: 'Bal (1 yemek kaşığı)', cal: 65, p: 0, c: 17, f: 0 },
        { keys: ['tereyağı', 'tereyagi', 'butter'], name: 'Tereyağı (10g)', cal: 72, p: 0, c: 0, f: 8 },
        { keys: ['reçel', 'recel', 'jam'], name: 'Reçel (1 yemek kaşığı)', cal: 50, p: 0, c: 13, f: 0 },

        // --- Tatlılar ---
        { keys: ['baklava'], name: 'Baklava (1 dilim)', cal: 250, p: 5, c: 30, f: 13 },
        { keys: ['künefe', 'kunefe'], name: 'Künefe (1 porsiyon)', cal: 450, p: 10, c: 52, f: 23 },
        { keys: ['sütlaç', 'sutlac', 'rice pudding'], name: 'Sütlaç (1 kase)', cal: 250, p: 7, c: 40, f: 7 },
        { keys: ['kazandibi'], name: 'Kazandibi (1 porsiyon)', cal: 220, p: 6, c: 35, f: 6 },
        { keys: ['revani'], name: 'Revani (1 dilim)', cal: 280, p: 4, c: 45, f: 10 },
        { keys: ['tulumba'], name: 'Tulumba (5 tane)', cal: 300, p: 3, c: 40, f: 15 },
        { keys: ['dondurma', 'ice cream'], name: 'Dondurma (1 top)', cal: 130, p: 2, c: 16, f: 7 },
        { keys: ['çikolata', 'cikolata', 'chocolate'], name: 'Çikolata (30g)', cal: 160, p: 2, c: 17, f: 9 },
        { keys: ['kek', 'cake'], name: 'Kek (1 dilim)', cal: 280, p: 4, c: 38, f: 13 },
        { keys: ['kurabiye', 'cookie', 'bisküvi', 'biskuvi'], name: 'Kurabiye (3 tane)', cal: 210, p: 3, c: 28, f: 10 },
        { keys: ['lokum'], name: 'Lokum (3 tane)', cal: 150, p: 1, c: 35, f: 1 },
        { keys: ['helva', 'tahin helvası'], name: 'Tahin Helvası (50g)', cal: 260, p: 5, c: 30, f: 14 },

        // --- İçecekler ---
        { keys: ['ayran'], name: 'Ayran (1 bardak)', cal: 60, p: 3, c: 4, f: 3 },
        { keys: ['süt', 'sut', 'milk'], name: 'Süt (1 bardak, 200ml)', cal: 120, p: 6, c: 10, f: 6 },
        { keys: ['çay', 'cay', 'tea'], name: 'Çay (şekersiz)', cal: 2, p: 0, c: 0, f: 0 },
        { keys: ['türk kahvesi', 'kahve', 'coffee'], name: 'Türk Kahvesi (şekersiz)', cal: 5, p: 0, c: 1, f: 0 },
        { keys: ['kola', 'cola', 'coca cola'], name: 'Kola (330ml)', cal: 140, p: 0, c: 35, f: 0 },
        { keys: ['meyve suyu', 'portakal suyu', 'juice'], name: 'Meyve Suyu (200ml)', cal: 90, p: 1, c: 22, f: 0 },
        { keys: ['protein shake', 'protein tozu', 'whey'], name: 'Protein Shake (1 scoop)', cal: 120, p: 24, c: 3, f: 1 },
        { keys: ['smoothie'], name: 'Meyve Smoothie (300ml)', cal: 180, p: 4, c: 38, f: 2 },

        // --- Meyve ---
        { keys: ['muz', 'banana'], name: 'Muz (1 tane)', cal: 105, p: 1, c: 27, f: 0 },
        { keys: ['elma', 'apple'], name: 'Elma (1 tane)', cal: 95, p: 0, c: 25, f: 0 },
        { keys: ['portakal', 'orange'], name: 'Portakal (1 tane)', cal: 62, p: 1, c: 15, f: 0 },
        { keys: ['üzüm', 'uzum', 'grape'], name: 'Üzüm (1 kase)', cal: 100, p: 1, c: 27, f: 0 },
        { keys: ['karpuz', 'watermelon'], name: 'Karpuz (1 dilim)', cal: 85, p: 2, c: 21, f: 0 },
        { keys: ['çilek', 'cilek', 'strawberry'], name: 'Çilek (1 kase)', cal: 50, p: 1, c: 12, f: 0 },

        // --- Kuruyemiş & Atıştırmalık ---
        { keys: ['ceviz', 'walnut'], name: 'Ceviz (30g)', cal: 200, p: 5, c: 4, f: 19 },
        { keys: ['badem', 'almond'], name: 'Badem (30g)', cal: 170, p: 6, c: 6, f: 15 },
        { keys: ['fındık', 'findik', 'hazelnut'], name: 'Fındık (30g)', cal: 180, p: 4, c: 5, f: 17 },
        { keys: ['fıstık', 'fistik', 'yer fıstığı', 'peanut'], name: 'Yer Fıstığı (30g)', cal: 170, p: 7, c: 5, f: 14 },
        { keys: ['cips', 'chips'], name: 'Cips (1 paket, 50g)', cal: 260, p: 3, c: 25, f: 17 },
        { keys: ['kraker', 'cracker'], name: 'Kraker (50g)', cal: 220, p: 4, c: 32, f: 9 },

        // --- Salata ---
        { keys: ['salata', 'mevsim salata', 'salad', 'yeşil salata'], name: 'Mevsim Salata', cal: 80, p: 3, c: 10, f: 4 },
        { keys: ['çoban salatası', 'coban salatasi', 'çoban salata'], name: 'Çoban Salatası', cal: 90, p: 2, c: 8, f: 6 },
        { keys: ['sezar salata', 'caesar'], name: 'Sezar Salata', cal: 250, p: 12, c: 12, f: 18 },

        // --- Fast Food ---
        { keys: ['dürüm', 'durum', 'wrap', 'tavuk dürüm'], name: 'Tavuk Dürüm', cal: 420, p: 22, c: 38, f: 20 },
        { keys: ['nugget', 'chicken nugget'], name: 'Chicken Nugget (6 tane)', cal: 280, p: 14, c: 18, f: 17 },
        { keys: ['patates kızartması', 'french fries', 'patates'], name: 'Patates Kızartması (orta)', cal: 340, p: 4, c: 44, f: 17 },

        // --- Ek Yemekler ---
        { keys: ['kestane', 'chestnut'], name: 'Kestane (100g)', cal: 213, p: 3, c: 45, f: 2 },
        { keys: ['çılbır', 'cilbir'], name: 'Çılbır (1 porsiyon)', cal: 280, p: 14, c: 5, f: 23 },
        { keys: ['enginar', 'zeytinyağlı enginar'], name: 'Zeytinyağlı Enginar (1 porsiyon)', cal: 180, p: 5, c: 18, f: 10 },
        { keys: ['midye', 'midye dolma', 'midye tava'], name: 'Midye Dolma (10 tane)', cal: 250, p: 12, c: 28, f: 10 },
        { keys: ['kokoreç', 'kokorec'], name: 'Kokoreç (yarım porsiyon)', cal: 350, p: 20, c: 25, f: 18 },
        { keys: ['tantuni'], name: 'Tantuni (1 dürüm)', cal: 380, p: 22, c: 30, f: 18 },
        { keys: ['çiğ köfte', 'cig kofte'], name: 'Çiğ Köfte (1 porsiyon)', cal: 250, p: 8, c: 40, f: 6 },
        { keys: ['hamsili pilav'], name: 'Hamsili Pilav (1 porsiyon)', cal: 320, p: 18, c: 38, f: 10 },
        { keys: ['içli köfte', 'icli kofte'], name: 'İçli Köfte (3 tane)', cal: 360, p: 15, c: 35, f: 18 },
        { keys: ['beyti', 'beyti kebap'], name: 'Beyti Kebap (1 porsiyon)', cal: 550, p: 32, c: 30, f: 34 },
        { keys: ['kuzu pirzola', 'pirzola'], name: 'Kuzu Pirzola (2 tane)', cal: 380, p: 32, c: 0, f: 28 },
        { keys: ['ciğer', 'ciger', 'arnavut ciğeri'], name: 'Arnavut Ciğeri (1 porsiyon)', cal: 300, p: 25, c: 15, f: 16 },
        { keys: ['yoğurt', 'yogurt'], name: 'Yoğurt (1 kase, 200g)', cal: 120, p: 6, c: 8, f: 7 },
        { keys: ['cacık', 'cacik'], name: 'Cacık (1 kase)', cal: 80, p: 4, c: 6, f: 4 },
        { keys: ['humus', 'hummus'], name: 'Humus (100g)', cal: 170, p: 8, c: 14, f: 10 },
        { keys: ['acılı ezme', 'ezme'], name: 'Acılı Ezme (100g)', cal: 100, p: 2, c: 8, f: 7 },
        { keys: ['kaşık helvası', 'un helvası', 'un helvasi'], name: 'Un Helvası (1 porsiyon)', cal: 350, p: 5, c: 42, f: 18 },
        { keys: ['aşure', 'asure'], name: 'Aşure (1 kase)', cal: 240, p: 5, c: 48, f: 3 },
        { keys: ['güllaç', 'gullac'], name: 'Güllaç (1 porsiyon)', cal: 200, p: 6, c: 35, f: 4 },
        { keys: ['kabak tatlısı', 'kabak tatlisi'], name: 'Kabak Tatlısı (1 porsiyon)', cal: 230, p: 2, c: 50, f: 3 },
        { keys: ['yulaf', 'yulaf ezmesi', 'oat', 'oatmeal'], name: 'Yulaf Ezmesi (50g)', cal: 190, p: 7, c: 34, f: 3 },
        { keys: ['granola'], name: 'Granola (50g)', cal: 230, p: 5, c: 32, f: 10 },
        { keys: ['avokado', 'avocado'], name: 'Avokado (yarım)', cal: 160, p: 2, c: 9, f: 15 },
        { keys: ['ton balığı', 'ton baligi', 'tuna'], name: 'Ton Balığı (konserve, 100g)', cal: 130, p: 28, c: 0, f: 2 },
        { keys: ['somon', 'salmon'], name: 'Izgara Somon (150g)', cal: 310, p: 34, c: 0, f: 19 },
        { keys: ['karides', 'shrimp'], name: 'Karides (100g)', cal: 100, p: 20, c: 1, f: 1 },
    ];

    // ========== SMART PORTION UNITS ==========
    const PORTION_UNITS = {
        porsiyon: '🍽️ Porsiyon',
        gram: '⚖️ Gram (g)',
        tane: '🍩 Tane',
        dilim: '🍕 Dilim',
        kase: '🥣 Kase',
        bardak: '🥛 Bardak',
        tabak: '🍛 Tabak',
        kaşık: '🥄 Kaşık',
    };

    // Basit kategori → birim eşleşmesi
    const FOOD_CATEGORY_UNITS = {
        porsiyon_gram: ['porsiyon', 'gram'],          // et, tavuk, balık, kebap, sebze yemekleri
        tabak_gram: ['tabak', 'porsiyon', 'gram'],    // pilav, makarna, salata
        adet_gram: ['tane', 'gram'],                  // meyve, kuruyemiş, yumurta, tatlı, börek, ekmek
        kase_gram: ['kase', 'bardak', 'gram'],        // çorbalar
        bardak_gram: ['bardak', 'gram'],              // içecekler
        kasik_gram: ['kaşık', 'gram'],                // bal, reçel, tereyağı
        dilim_gram: ['dilim', 'tane', 'gram'],        // pizza, kek, börek
        sadece_gram: ['gram'],                        // bilinmeyen yemekler
    };

    // Yemek adı → kategori eşleşmesi
    const FOOD_KEYWORDS = {
        // Et & Tavuk & Balık & Kebap → porsiyon / gram
        porsiyon_gram: [
            'et ', 'köfte', 'kofte', 'biftek', 'steak', 'kuşbaşı', 'kusbasi', 'pirzola', 'ciğer', 'ciger', 'sucuk', 'sote',
            'tavuk', 'chicken', 'nugget',
            'balık', 'balik', 'somon', 'salmon', 'ton balığı', 'tuna', 'karides', 'shrimp', 'hamsi', 'levrek', 'çupra', 'midye',
            'kebap', 'kebab', 'döner', 'doner', 'iskender', 'tantuni', 'kokoreç', 'kokorec', 'beyti', 'adana', 'urfa', 'dürüm', 'durum',
            'musakka', 'türlü', 'turlu', 'bamya', 'enginar', 'çılbır', 'cilbir', 'menemen', 'omlet',
            'karnıyarık', 'karniyarik', 'imam bayıldı', 'fasulye', 'nohut', 'dolma', 'sarma',
            'çiğ köfte', 'künefe', 'kunefe', 'mantı', 'manti', 'sahanda',
        ],
        // Pilav & Makarna & Salata → tabak / gram
        tabak_gram: [
            'pilav', 'pirinç', 'pirinc', 'bulgur', 'rice',
            'makarna', 'spagetti', 'pasta', 'noodle', 'erişte', 'eriste',
            'salata', 'salad', 'sezar', 'caesar', 'çoban',
            'yulaf', 'oat', 'granola',
        ],
        // Meyve & Kuruyemiş & Yumurta & Tatlı & Hamurişi → adet / gram
        adet_gram: [
            'muz', 'banana', 'elma', 'apple', 'portakal', 'orange', 'karpuz', 'watermelon', 'çilek', 'cilek', 'üzüm', 'uzum', 'avokado',
            'ceviz', 'walnut', 'badem', 'almond', 'fındık', 'findik', 'fıstık', 'fistik', 'kestane',
            'yumurta', 'egg',
            'baklava', 'tulumba', 'donut', 'lokma', 'kurabiye', 'cookie', 'lokum', 'çikolata', 'cikolata', 'dondurma',
            'simit', 'poğaça', 'pogaca', 'açma', 'acma', 'bazlama', 'gözleme', 'gozleme', 'lahmacun',
            'hamburger', 'burger', 'tost', 'toast', 'zeytin',
            'cips', 'chips', 'kraker', 'cracker',
            'sigara böreği',
        ],
        // Çorbalar → kase / gram
        kase_gram: [
            'çorba', 'corba', 'soup', 'mercimek', 'ezogelin', 'tarhana', 'yayla', 'işkembe', 'iskembe',
            'sütlaç', 'sutlac', 'kazandibi', 'aşure', 'asure', 'cacık', 'cacik', 'yoğurt', 'yogurt',
        ],
        // İçecekler → bardak / gram
        bardak_gram: [
            'ayran', 'süt', 'sut', 'milk', 'çay', 'cay', 'tea', 'kahve', 'coffee',
            'kola', 'cola', 'meyve suyu', 'juice', 'smoothie', 'protein shake', 'protein tozu', 'whey', 'şalgam',
        ],
        // Kaşıklık → kaşık / gram
        kasik_gram: [
            'bal', 'honey', 'tereyağı', 'butter', 'reçel', 'jam', 'humus', 'hummus', 'ezme',
        ],
        // Dilimlik → dilim / gram
        dilim_gram: [
            'pizza', 'pide', 'börek', 'borek', 'ekmek', 'bread', 'kek', 'cake', 'revani', 'helva',
            'peynir', 'cheese', 'kaşar', 'kasar', 'güllaç', 'gullac', 'kabak tatlısı',
            'patates kızartması', 'french fries',
        ],
    };

    function detectFoodCategory(foodName) {
        if (!foodName) return 'sadece_gram';
        const q = foodName.toLowerCase().trim();
        for (const [category, keywords] of Object.entries(FOOD_KEYWORDS)) {
            for (const kw of keywords) {
                if (q.includes(kw)) return category;
            }
        }
        return 'sadece_gram';
    }

    function updatePortionUnits(foodName) {
        const select = $('#portion-unit');
        if (!select) return;

        const category = detectFoodCategory(foodName);
        const units = FOOD_CATEGORY_UNITS[category] || FOOD_CATEGORY_UNITS['sadece_gram'];
        const currentValue = select.value;

        select.innerHTML = units.map(u =>
            `<option value="${u}"${u === currentValue ? ' selected' : ''}>${PORTION_UNITS[u] || u}</option>`
        ).join('');

        if (!units.includes(currentValue)) {
            select.value = units[0];
        }
    }

    // ========== FOOD ESTIMATOR ==========
    const FoodEstimator = {
        // Search local DB with fuzzy matching
        searchLocalDB(query) {
            const q = query.toLowerCase().replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[çÇ]/g, 'c')
                .replace(/[ğĞ]/g, 'g').replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o');

            // Extract quantity multiplier (e.g., "3 tane donut" → 3)
            const qtyMatch = q.match(/^(\d+(?:[.,]\d+)?)\s*(porsiyon|tane|dilim|kase|bardak|tabak|gram|gr|g|kg)?\s*/);
            let multiplier = 1;
            let searchQuery = q;
            let gramAmount = null;

            if (qtyMatch) {
                const num = parseFloat(qtyMatch[1].replace(',', '.'));
                const unit = qtyMatch[2] || '';
                searchQuery = q.slice(qtyMatch[0].length).trim();

                if (unit === 'gram' || unit === 'gr' || unit === 'g') {
                    gramAmount = num;
                } else if (unit === 'kg') {
                    gramAmount = num * 1000;
                } else {
                    multiplier = num;
                }
            }

            // Also handle "200g tavuk" pattern
            const gramPattern = searchQuery.match(/^(\d+)\s*g\s+/);
            if (gramPattern && !gramAmount) {
                gramAmount = parseFloat(gramPattern[1]);
                searchQuery = searchQuery.slice(gramPattern[0].length).trim();
            }

            // Find best match
            let bestMatch = null;
            let bestScore = 0;

            for (const food of FOOD_DB) {
                for (const key of food.keys) {
                    const normalizedKey = key.toLowerCase().replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's')
                        .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o');

                    let score = 0;
                    if (searchQuery === normalizedKey) score = 100;
                    else if (searchQuery.includes(normalizedKey)) score = 80;
                    else if (normalizedKey.includes(searchQuery)) score = 60;
                    else {
                        // Word-level match
                        const words = searchQuery.split(/\s+/);
                        const keyWords = normalizedKey.split(/\s+/);
                        const matches = words.filter(w => keyWords.some(kw => kw.includes(w) || w.includes(kw)));
                        if (matches.length > 0) score = (matches.length / words.length) * 50;
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = food;
                    }
                }
            }

            if (bestMatch && bestScore >= 30) {
                let cal, p, c, f, name;

                if (gramAmount && bestMatch.per100g) {
                    // Calculate based on gram amount
                    const factor = gramAmount / 100;
                    cal = Math.round(bestMatch.per100g.cal * factor);
                    p = Math.round(bestMatch.per100g.p * factor * 10) / 10;
                    c = Math.round(bestMatch.per100g.c * factor * 10) / 10;
                    f = Math.round(bestMatch.per100g.f * factor * 10) / 10;
                    name = bestMatch.name.replace(/\(.*\)/, `(${gramAmount}g)`);
                } else if (gramAmount) {
                    // Approximate: assume default portion is ~200g
                    const factor = gramAmount / 200;
                    cal = Math.round(bestMatch.cal * factor);
                    p = Math.round(bestMatch.p * factor * 10) / 10;
                    c = Math.round(bestMatch.c * factor * 10) / 10;
                    f = Math.round(bestMatch.f * factor * 10) / 10;
                    name = bestMatch.name.replace(/\(.*\)/, `(${gramAmount}g)`);
                } else {
                    cal = Math.round(bestMatch.cal * multiplier);
                    p = Math.round(bestMatch.p * multiplier * 10) / 10;
                    c = Math.round(bestMatch.c * multiplier * 10) / 10;
                    f = Math.round(bestMatch.f * multiplier * 10) / 10;
                    name = multiplier > 1 ? `${multiplier}x ${bestMatch.name}` : bestMatch.name;
                }

                return { name, calories: cal, protein: p, carbs: c, fat: f };
            }

            return null; // Not found
        },

        // Gemini API (fallback for unknown foods)
        async estimateWithAI(foodDescription) {
            const prompt = `Sen bir beslenme uzmanısın. Kullanıcı şu yemeği sordu: "${foodDescription}". Bu yemeğin yaklaşık besin değerlerini tahmin et. Cevabını JSON formatında ver: {"name": "yemek adı (Türkçe)", "calories": 0, "protein": 0, "carbs": 0, "fat": 0}. Değerler: calories=kcal, protein/carbs/fat=gram.`;
            try {
                const data = await Store.callGemini(prompt);
                console.log('[FitTrack] AI Estimate:', JSON.stringify(data));
                return this._extractResult(data);
            } catch (err) {
                console.error('[FitTrack] AI Estimate Error:', err);
                throw err;
            }
        },

        async estimateFromImage(base64Image, mimeType) {
            const prompt = `Bu fotoğraftaki yemeği analiz et. JSON formatında ver: {"name": "yemek adı", "calories": 0, "protein": 0, "carbs": 0, "fat": 0}`;
            try {
                const data = await Store.callGemini(prompt, { mimeType, data: base64Image });
                console.log('[FitTrack] Image Analysis:', JSON.stringify(data));
                return this._extractResult(data);
            } catch (err) {
                console.error('[FitTrack] Image Analysis Error:', err);
                throw err;
            }
        },

        _extractResult(data) {
            const parts = data?.candidates?.[0]?.content?.parts || [];
            // Collect text from non-thought parts (thinking model compatibility)
            let text = '';
            for (const part of parts) {
                if (part.text && !part.thought) text += part.text;
            }
            if (!text) {
                for (const part of parts) {
                    if (part.text) text += part.text;
                }
            }
            console.log('[FitTrack] Extracted text:', text);
            if (!text) throw new Error('AI yanıt vermedi.');

            // Clean and parse
            let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

            // Try direct parse
            try {
                const r = JSON.parse(cleaned);
                if (r.calories !== undefined) return this._norm(r);
            } catch (e) { }

            // Try regex extraction
            const m = cleaned.match(/\{[^{}]*"calories"\s*:\s*\d+[^{}]*\}/) || cleaned.match(/\{[\s\S]*?\}/);
            if (m) {
                try {
                    const r = JSON.parse(m[0]);
                    if (r.calories !== undefined) return this._norm(r);
                } catch (e) { }
            }

            throw new Error('AI yanıtı okunamadı: ' + text.substring(0, 100));
        },

        _norm(r) {
            return {
                name: r.name || 'AI Tahmin',
                calories: Math.round(Number(r.calories)) || 0,
                protein: Math.round(Number(r.protein) * 10) / 10 || 0,
                carbs: Math.round(Number(r.carbs) * 10) / 10 || 0,
                fat: Math.round(Number(r.fat) * 10) / 10 || 0
            };
        },

        async estimate(foodDescription) {
            // 1. Check local DB first
            const localResult = this.searchLocalDB(foodDescription);
            if (localResult) return localResult;

            // 2. Check cache (previously AI-estimated foods)
            const cached = Store.getCachedFood(foodDescription);
            if (cached) {
                console.log('[FitTrack] Cache hit:', foodDescription);
                return { name: cached.name, calories: cached.calories, protein: cached.protein, carbs: cached.carbs, fat: cached.fat };
            }

            // 3. Call AI and cache the result
            const aiResult = await this.estimateWithAI(foodDescription);
            Store.cacheFoodResult(foodDescription, aiResult);
            console.log('[FitTrack] Cached new food:', foodDescription);
            return aiResult;
        }
    };

    // ========== NAVIGATION ==========
    function openDrawer() {
        $('#drawer-menu').classList.add('open');
        $('#drawer-overlay').classList.add('open');
    }

    function closeDrawer() {
        $('#drawer-menu').classList.remove('open');
        $('#drawer-overlay').classList.remove('open');
    }

    function initNavigation() {
        // Hamburger buttons (one per page header)
        $$('.hamburger-btn').forEach(btn => {
            btn.addEventListener('click', openDrawer);
        });

        // Drawer items
        $$('.drawer-item').forEach(btn => {
            btn.addEventListener('click', () => {
                navigateTo(btn.dataset.page);
                closeDrawer();
            });
        });

        // Close drawer
        $('#drawer-close').addEventListener('click', closeDrawer);
        $('#drawer-overlay').addEventListener('click', closeDrawer);
    }

    function navigateTo(page) {
        $$('.page').forEach(p => p.classList.remove('active'));
        $$('.drawer-item').forEach(n => n.classList.remove('active'));

        const pageEl = $(`#page-${page}`);
        const navEl = $(`.drawer-item[data-page="${page}"]`);

        if (pageEl) { pageEl.classList.add('active'); pageEl.style.animation = 'none'; pageEl.offsetHeight; pageEl.style.animation = ''; }
        if (navEl) navEl.classList.add('active');

        refreshPage(page);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function refreshPage(page) {
        switch (page) {
            case 'dashboard': renderDashboard(); break;
            case 'exercises': renderExercisesPage(); break;
            case 'calories': renderCaloriePage(); break;
            case 'profile': renderProfilePage(); break;
            case 'program': renderProgramPage(); break;
            case 'ai-program': renderAIProgramPage(); break;
        }
    }

    // ========== CHART HELPERS ==========
    const chartInstances = {};

    function getOrCreateChart(canvasId, config) {
        const canvas = $(`#${canvasId}`);
        if (!canvas) return null;
        if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
        chartInstances[canvasId] = new Chart(canvas.getContext('2d'), config);
        return chartInstances[canvasId];
    }

    function defaultChartOptions(yLabel = '') {
        return {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(17, 22, 56, 0.95)', titleColor: '#f0f0f5', bodyColor: '#f0f0f5',
                    borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, cornerRadius: 10, padding: 12,
                    titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }, ticks: { color: 'rgba(240,240,245,0.4)', font: { family: 'Inter', size: 10 }, maxRotation: 45 } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                    ticks: { color: 'rgba(240,240,245,0.4)', font: { family: 'Inter', size: 11 } },
                    title: yLabel ? { display: true, text: yLabel, color: 'rgba(240,240,245,0.4)', font: { family: 'Inter', size: 11 } } : { display: false }
                }
            }
        };
    }

    function getLastNDaysLabels(n) {
        const labels = [];
        for (let i = n - 1; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            labels.push(d.toISOString().slice(0, 10));
        }
        return labels;
    }

    // ========== MACRO HELPERS ==========
    function getDayMacros(meals, dateStr) {
        const dayMeals = meals.filter(m => m.date === dateStr);
        return {
            calories: dayMeals.reduce((s, m) => s + (m.calories || 0), 0),
            protein: dayMeals.reduce((s, m) => s + (m.protein || 0), 0),
            carbs: dayMeals.reduce((s, m) => s + (m.carbs || 0), 0),
            fat: dayMeals.reduce((s, m) => s + (m.fat || 0), 0)
        };
    }

    // ========== DASHBOARD ==========
    function renderDashboard() {
        const profile = Store.getProfile();
        const workouts = Store.getWorkouts() || [];
        const meals = Store.getMeals() || [];
        const today = todayStr();

        // Date
        const dateEl = $('#current-date');
        if (dateEl) {
            dateEl.textContent = new Date().toLocaleDateString('tr-TR', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
            });
        }

        // Today macros
        const macros = getDayMacros(meals, today);
        const remaining = Math.max(0, (profile?.calorieGoal || 2000) - macros.calories);

        if ($('#dash-calories')) $('#dash-calories').textContent = macros.calories.toLocaleString('tr-TR');
        if ($('#dash-remaining')) $('#dash-remaining').textContent = remaining.toLocaleString('tr-TR');

        // Weekly workouts
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        const weekAgoStr = weekAgo.toISOString().slice(0, 10);
        const thisWeekDates = [...new Set(workouts.filter(w => w.date >= weekAgoStr).map(w => w.date))];
        if ($('#dash-workouts')) $('#dash-workouts').textContent = thisWeekDates.length;
        if ($('#dash-exercises')) $('#dash-exercises').textContent = Store.getUsedExercises().length;

        // Macro summary
        if ($('#dash-macro-cal')) $('#dash-macro-cal').textContent = macros.calories;
        if ($('#dash-macro-protein')) $('#dash-macro-protein').textContent = Math.round(macros.protein) + 'g';
        if ($('#dash-macro-carbs')) $('#dash-macro-carbs').textContent = Math.round(macros.carbs) + 'g';
        if ($('#dash-macro-fat')) $('#dash-macro-fat').textContent = Math.round(macros.fat) + 'g';

        // Macro bars
        const goal = profile?.calorieGoal || 2000;
        const calPercent = Math.min(100, goal > 0 ? (macros.calories / goal) * 100 : 0);
        const proteinTarget = (goal * 0.30) / 4;
        const carbsTarget = (goal * 0.50) / 4;
        const fatTarget = (goal * 0.20) / 9;

        if ($('#dash-macro-cal-bar')) $('#dash-macro-cal-bar').style.width = calPercent + '%';
        if ($('#dash-macro-protein-bar')) $('#dash-macro-protein-bar').style.width = Math.min(100, proteinTarget > 0 ? (macros.protein / proteinTarget) * 100 : 0) + '%';
        if ($('#dash-macro-carbs-bar')) $('#dash-macro-carbs-bar').style.width = Math.min(100, carbsTarget > 0 ? (macros.carbs / carbsTarget) * 100 : 0) + '%';
        if ($('#dash-macro-fat-bar')) $('#dash-macro-fat-bar').style.width = Math.min(100, fatTarget > 0 ? (macros.fat / fatTarget) * 100 : 0) + '%';

        // Progress ring
        const circumference = 2 * Math.PI * 85;
        const ring = $('#calorie-ring');
        if (ring) {
            ring.style.strokeDasharray = circumference;
            ring.style.strokeDashoffset = circumference - (calPercent / 100) * circumference;
            ring.style.stroke = calPercent > 100 ? '#ff4d6a' : calPercent > 80 ? '#ffb347' : '#00d4aa';
        }
        if ($('#ring-percent')) $('#ring-percent').textContent = Math.round(calPercent) + '%';

        renderRecentWorkouts(workouts);
        renderDashCalorieChart(meals, profile);
    }

    function renderRecentWorkouts(workouts) {
        const container = $('#dash-recent-workouts');
        if (workouts.length === 0) { container.innerHTML = '<p class="empty-state">Henüz antrenman kaydı yok.</p>'; return; }

        const byDate = {};
        workouts.forEach(w => { if (!byDate[w.date]) byDate[w.date] = []; byDate[w.date].push(w); });
        const dates = Object.keys(byDate).sort().reverse().slice(0, 5);

        container.innerHTML = dates.map(date => {
            const entries = byDate[date];
            return `<div class="data-item">
                <div class="data-item-info">
                    <span class="data-item-primary">${formatDate(date)}</span>
                    <span class="data-item-secondary">${entries.map(e => e.exercise).join(', ')}</span>
                </div>
                <div class="data-item-value">${entries.length} hareket</div>
            </div>`;
        }).join('');
    }

    function renderDashCalorieChart(meals, profile) {
        const days = getLastNDaysLabels(7);
        const labels = days.map(d => formatDateShort(d));
        const calData = days.map(d => getDayMacros(meals, d).calories);

        getOrCreateChart('dash-calorie-chart', {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: calData,
                    backgroundColor: calData.map(v => v > profile.calorieGoal ? 'rgba(255, 77, 106, 0.6)' : 'rgba(0, 212, 170, 0.6)'),
                    borderColor: calData.map(v => v > profile.calorieGoal ? '#ff4d6a' : '#00d4aa'),
                    borderWidth: 1.5, borderRadius: 6, borderSkipped: false
                }]
            },
            options: defaultChartOptions('kcal')
        });
    }

    // ========== EXERCISES PAGE ==========
    function renderExercisesPage() {
        $('#workout-date').value = todayStr();
        populateExerciseFilter();
        renderExerciseHistory();
    }

    function populateExerciseFilter() {
        const filterSelect = $('#history-exercise-filter');
        const used = Store.getUsedExercises();
        const currentVal = filterSelect.value;
        filterSelect.innerHTML = '<option value="all">Tüm Hareketler</option>' +
            used.map(ex => `<option value="${ex}">${ex}</option>`).join('');
        if (used.includes(currentVal) || currentVal === 'all') filterSelect.value = currentVal;
    }

    function renderExerciseHistory() {
        const workouts = Store.getWorkouts();
        const filter = $('#history-exercise-filter').value;
        let filtered = filter !== 'all' ? workouts.filter(w => w.exercise === filter) : workouts;

        renderWorkoutList(filtered);

        const chartContainer = $('#exercise-chart-container');
        if (filter !== 'all' && filtered.length > 0) {
            chartContainer.style.display = 'block';
            renderExerciseChart(filtered, filter);
        } else {
            chartContainer.style.display = 'none';
        }
    }

    function renderWorkoutList(workouts) {
        const container = $('#workout-list');
        if (workouts.length === 0) { container.innerHTML = '<p class="empty-state">Henüz antrenman kaydı yok.</p>'; return; }

        const prs = Store.getPersonalRecords();
        container.innerHTML = [...workouts].reverse().map(w => {
            const isPR = prs[w.exercise] && prs[w.exercise].weight === w.weight && prs[w.exercise].date === w.date;
            return `<div class="data-item">
                <div class="data-item-info">
                    <span class="data-item-primary">${w.exercise}${isPR ? ' <span class="exercise-badge" style="background:rgba(255,179,71,0.2);color:#ffb347;">🏆 PR</span>' : ''}</span>
                    <span class="data-item-secondary">${formatDate(w.date)} · ${w.sets}×${w.reps}</span>
                </div>
                <div class="data-item-value">${w.weight} kg</div>
                <div class="data-item-actions"><button class="btn-delete" onclick="FitTrack.deleteWorkout('${w.id}')" title="Sil">🗑️</button></div>
            </div>`;
        }).join('');
    }

    function renderExerciseChart(workouts, name) {
        const byDate = {};
        workouts.forEach(w => { if (!byDate[w.date] || w.weight > byDate[w.date]) byDate[w.date] = w.weight; });
        const dates = Object.keys(byDate).sort();

        getOrCreateChart('exercise-chart', {
            type: 'line',
            data: {
                labels: dates.map(d => formatDateShort(d)),
                datasets: [{
                    label: name, data: dates.map(d => byDate[d]),
                    borderColor: '#7c5cfc', backgroundColor: 'rgba(124, 92, 252, 0.1)',
                    fill: true, tension: 0.3, borderWidth: 2.5, pointRadius: 5,
                    pointBackgroundColor: '#7c5cfc', pointBorderColor: '#111638', pointBorderWidth: 2, pointHoverRadius: 7
                }]
            },
            options: {
                ...defaultChartOptions('kg'),
                plugins: {
                    ...defaultChartOptions('kg').plugins,
                    legend: { display: true, labels: { color: 'rgba(240,240,245,0.6)', font: { family: 'Inter', size: 12, weight: '600' }, usePointStyle: true, pointStyle: 'circle', padding: 16 } }
                }
            }
        });
    }

    function handleAddWorkout(e) {
        e.preventDefault();
        const exercise = $('#exercise-input').value.trim();
        const weight = parseFloat($('#workout-weight').value);
        const sets = parseInt($('#workout-sets').value);
        const reps = parseInt($('#workout-reps').value);
        const date = $('#workout-date').value;

        if (!exercise || !weight || !sets || !reps || !date) { showToast('Tüm alanları doldurun', true); return; }

        const prs = Store.getPersonalRecords();
        const isPR = !prs[exercise] || weight > prs[exercise].weight;
        Store.addWorkout({ id: generateId(), date, exercise, weight, sets, reps });

        showToast(isPR ? `🏆 Yeni PR! ${exercise}: ${weight} kg` : `${exercise}: ${weight}kg × ${sets}×${reps} ✓`);
        $('#exercise-input').value = '';
        $('#workout-weight').value = '';
        $('#workout-sets').value = '';
        $('#workout-reps').value = '';
        renderExercisesPage();
    }

    // ---- Move (Takip) Exercise Autocomplete ----
    function initExerciseTakipAutocomplete() {
        const input = $('#exercise-input');
        const dropdown = $('#exercise-suggestions');
        if (!input || !dropdown) return;

        function buildDropdown(filter) {
            filter = (filter || '').toLowerCase().trim();
            let html = '';

            for (const [cat, exercises] of Object.entries(EXERCISE_LIBRARY)) {
                const filtered = filter
                    ? exercises.filter(ex => ex.toLowerCase().includes(filter))
                    : exercises;
                if (filtered.length === 0) continue;

                html += `<div class="suggestion-category">${cat}</div>`;
                html += filtered.map(ex =>
                    `<div class="suggestion-item" data-exercise="${ex}">${ex}</div>`
                ).join('');
            }

            if (!html) {
                html = `<div class="suggestion-empty">Hareket bulunamadı. İsmini yazıp ekleyebilirsin.</div>`;
            }

            dropdown.innerHTML = html;

            dropdown.querySelectorAll('.suggestion-item').forEach(item => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    input.value = item.dataset.exercise;
                    dropdown.style.display = 'none';
                    input.focus();
                });
            });
        }

        function open() { buildDropdown(input.value); dropdown.style.display = 'block'; }
        function close() { dropdown.style.display = 'none'; }

        input.addEventListener('focus', open);
        input.addEventListener('input', open);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Tab') { close(); return; }
            if (dropdown.style.display !== 'none') {
                const items = [...dropdown.querySelectorAll('.suggestion-item')];
                const current = dropdown.querySelector('.suggestion-item.active');
                let idx = items.indexOf(current);

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (current) current.classList.remove('active');
                    idx = Math.min(idx + 1, items.length - 1);
                    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (current) current.classList.remove('active');
                    idx = Math.max(idx - 1, 0);
                    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'Enter' && current) {
                    e.preventDefault();
                    input.value = current.dataset.exercise;
                    close();
                }
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) close();
        });
    }

    // ========== CALORIE PAGE ==========
    let currentPhotoData = null;

    function renderCaloriePage() {
        const profile = Store.getProfile();
        const meals = Store.getMeals();
        const macros = getDayMacros(meals, todayStr());
        const remaining = Math.max(0, profile.calorieGoal - macros.calories);

        $('#cal-eaten').textContent = macros.calories.toLocaleString('tr-TR');
        $('#cal-target').textContent = profile.calorieGoal.toLocaleString('tr-TR');
        $('#cal-remain').textContent = remaining.toLocaleString('tr-TR');

        // Macro pills
        $('#cal-page-protein').textContent = Math.round(macros.protein) + 'g';
        $('#cal-page-carbs').textContent = Math.round(macros.carbs) + 'g';
        $('#cal-page-fat').textContent = Math.round(macros.fat) + 'g';

        // Progress bar
        const percent = Math.min(100, profile.calorieGoal > 0 ? (macros.calories / profile.calorieGoal) * 100 : 0);
        const bar = $('#calorie-progress-bar');
        bar.style.width = percent + '%';
        bar.style.background = macros.calories > profile.calorieGoal ? 'linear-gradient(135deg, #ff4d6a 0%, #ff8a5c 100%)' : '';

        renderMealList(meals.filter(m => m.date === todayStr()));
        renderCalorieChart(meals, profile);
    }

    function renderMealList(meals) {
        const container = $('#meal-list');
        if (meals.length === 0) { container.innerHTML = '<p class="empty-state">Henüz yemek eklenmedi.</p>'; return; }

        const badgeMap = { 'Kahvaltı': 'kahvalti', 'Öğle': 'ogle', 'Akşam': 'aksam', 'Atıştırmalık': 'atistirmalik' };

        container.innerHTML = meals.map(m => `
            <div class="data-item">
                <div class="data-item-info">
                    <span class="data-item-primary">${m.name} <span class="meal-badge ${badgeMap[m.mealTime] || ''}">${m.mealTime}</span></span>
                    <div class="data-item-macros">
                        <span class="macro-p">P: ${m.protein || 0}g</span>
                        <span class="macro-c">K: ${m.carbs || 0}g</span>
                        <span class="macro-f">Y: ${m.fat || 0}g</span>
                    </div>
                </div>
                <div class="data-item-value">${m.calories} kcal</div>
                <div class="data-item-actions"><button class="btn-delete" onclick="FitTrack.deleteMeal('${m.id}')" title="Sil">🗑️</button></div>
            </div>
        `).join('');
    }

    function renderCalorieChart(meals, profile) {
        const days = getLastNDaysLabels(7);
        const labels = days.map(d => formatDateShort(d));
        const calData = days.map(d => getDayMacros(meals, d).calories);

        getOrCreateChart('calorie-chart', {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: calData,
                    backgroundColor: calData.map(v => v > profile.calorieGoal ? 'rgba(255, 77, 106, 0.6)' : 'rgba(0, 212, 170, 0.6)'),
                    borderColor: calData.map(v => v > profile.calorieGoal ? '#ff4d6a' : '#00d4aa'),
                    borderWidth: 1.5, borderRadius: 6, borderSkipped: false
                }]
            },
            options: defaultChartOptions('kcal')
        });
    }

    // --- AI Estimation ---
    function setAILoading(loading) {
        const loader = $('#ai-loading');
        const btn1 = $('#btn-ai-estimate');
        const btn2 = $('#btn-ai-photo-label');
        if (loading) {
            loader.style.display = 'flex';
            btn1.classList.add('loading');
            btn2.classList.add('loading');
        } else {
            loader.style.display = 'none';
            btn1.classList.remove('loading');
            btn2.classList.remove('loading');
        }
    }

    function fillFormWithAIResult(result) {
        if (result.name) $('#meal-name').value = result.name;
        if (result.calories) $('#meal-calories').value = result.calories;
        if (result.protein) $('#meal-protein').value = result.protein;
        if (result.carbs) $('#meal-carbs').value = result.carbs;
        if (result.fat) $('#meal-fat').value = result.fat;
    }

    async function handleAIEstimate() {
        const foodName = $('#meal-name').value.trim();
        if (!foodName) { showToast('Önce yemek adı yazın', true); return; }

        const portionAmount = $('#portion-amount').value || '1';
        const portionUnit = $('#portion-unit').value || 'porsiyon';
        const foodQuery = `${portionAmount} ${portionUnit} ${foodName}`;

        setAILoading(true);
        try {
            const result = await FoodEstimator.estimate(foodQuery);
            fillFormWithAIResult(result);
            showToast('🤖 AI tahmini tamamlandı');
        } catch (err) {
            showToast(err.message, true);
        } finally {
            setAILoading(false);
        }
    }

    function handlePhotoSelect(e) {
        const file = e.target.files[0];
        if (!file) return;

        // Preview
        const reader = new FileReader();
        reader.onload = async function (ev) {
            const dataUrl = ev.target.result;
            const base64 = dataUrl.split(',')[1];
            const mimeType = file.type || 'image/jpeg';

            // Show preview
            $('#photo-preview').src = dataUrl;
            $('#photo-preview-container').style.display = 'block';
            currentPhotoData = { base64, mimeType };

            // Auto-analyze
            setAILoading(true);
            try {
                const result = await FoodEstimator.estimateFromImage(base64, mimeType);
                fillFormWithAIResult(result);
                showToast('📸 Fotoğraf analizi tamamlandı');
            } catch (err) {
                showToast(err.message, true);
            } finally {
                setAILoading(false);
            }
        };
        reader.readAsDataURL(file);
    }

    function handleRemovePhoto() {
        currentPhotoData = null;
        $('#photo-preview-container').style.display = 'none';
        $('#photo-input').value = '';
    }

    function handleAddMeal(e) {
        e.preventDefault();
        const name = $('#meal-name').value.trim();
        const calories = parseInt($('#meal-calories').value) || 0;
        const protein = parseFloat($('#meal-protein').value) || 0;
        const carbs = parseFloat($('#meal-carbs').value) || 0;
        const fat = parseFloat($('#meal-fat').value) || 0;
        const mealTime = $('#meal-time').value;

        if (!name) { showToast('Yemek adı girin', true); return; }
        if (!calories && !protein && !carbs && !fat) { showToast('En az bir besin değeri girin', true); return; }

        Store.addMeal({ id: generateId(), date: todayStr(), name, calories, protein, carbs, fat, mealTime });
        showToast(`${name} eklendi (${calories} kcal) ✓`);

        // Reset form
        $('#meal-name').value = '';
        $('#portion-amount').value = '1';
        updatePortionUnits(''); // reset to default units
        $('#meal-calories').value = '';
        $('#meal-protein').value = '';
        $('#meal-carbs').value = '';
        $('#meal-fat').value = '';
        handleRemovePhoto();
        renderCaloriePage();
    }

    // ========== PROFILE PAGE ==========
    function renderProfilePage() {
        const profile = Store.getProfile();
        $('#profile-height').value = profile.height || '';
        $('#profile-age').value = profile.age || '';
        $('#profile-body-weight').value = profile.bodyWeight || '';
        $('#profile-calorie-goal').value = profile.calorieGoal || '';

        // API Key (masked display)
        const apiKey = Store.getApiKey();
        if (apiKey) { $('#gemini-api-key').value = apiKey; }

        renderPRList();

        // Stats
        const workouts = Store.getWorkouts();
        const meals = Store.getMeals();
        $('#stat-total-workouts').textContent = workouts.length;
        $('#stat-total-meals').textContent = meals.length;
        $('#stat-unique-exercises').textContent = Store.getUsedExercises().length;

        const days = getLastNDaysLabels(7);
        const daysWithData = days.filter(d => meals.some(m => m.date === d));
        if (daysWithData.length > 0) {
            const avg = daysWithData.reduce((sum, d) => sum + getDayMacros(meals, d).calories, 0) / daysWithData.length;
            $('#stat-avg-calories').textContent = Math.round(avg).toLocaleString('tr-TR') + ' kcal';
        } else {
            $('#stat-avg-calories').textContent = '--';
        }
    }

    function renderPRList() {
        const container = $('#pr-list');
        const entries = Object.entries(Store.getPersonalRecords());
        if (entries.length === 0) { container.innerHTML = '<p class="empty-state">Antrenman kaydı ekledikçe rekorlarınız görünecek.</p>'; return; }

        entries.sort((a, b) => b[1].weight - a[1].weight);
        container.innerHTML = entries.map(([ex, pr]) => `
            <div class="pr-item"><span class="pr-exercise">🏆 ${ex}</span><div class="pr-value">${pr.weight} kg</div></div>
        `).join('');
    }

    function handleSaveProfile(e) {
        e.preventDefault();
        Store.setProfile({
            height: parseInt($('#profile-height').value) || 175,
            age: parseInt($('#profile-age').value) || 25,
            bodyWeight: parseFloat($('#profile-body-weight').value) || 75,
            calorieGoal: parseInt($('#profile-calorie-goal').value) || 2000
        });
        showToast('Profil kaydedildi ✓');
    }

    function handleSaveApiKey(e) {
        e.preventDefault();
        const key = $('#gemini-api-key').value.trim();
        if (!key) { showToast('API anahtarı girin', true); return; }
        Store.setApiKey(key);
        showToast('🔑 API anahtarı kaydedildi ✓');
    }

    function handleExportData() {
        const blob = new Blob([Store.exportData()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `fittrack_backup_${todayStr()}.json`;
        a.click(); URL.revokeObjectURL(url);
        showToast('Veriler indirildi ✓');
    }

    function handleResetData() {
        if (confirm('Tüm verileriniz silinecek! Bu işlem geri alınamaz. Emin misiniz?')) {
            Store.clearAll();
            showToast('Tüm veriler silindi');
            navigateTo('dashboard');
        }
    }

    // ========== EXERCISE LIBRARY & AUTOCOMPLETE ==========
    const EXERCISE_LIBRARY = {
        '💪 Göğüs': [
            'Bench Press', 'Incline Bench Press', 'Decline Bench Press',
            'Incline Dumbbell Press', 'Dumbbell Fly', 'Cable Crossover',
            'Cable Fly (Yüksek)', 'Cable Fly (Alçak)', 'Chest Press Machine',
            'Pec Deck (Butterfly)', 'Push Up', 'Wide Push Up',
            'Dips (Göğüs)', 'Weighted Dips'
        ],
        '🏋️ Sırt': [
            'Lat Pulldown', 'Wide Grip Pulldown', 'Close Grip Pulldown',
            'Barbell Row', 'Seated Cable Row', 'Single Arm Dumbbell Row',
            'T-Bar Row', 'Chest Supported Row', 'Pull Up', 'Chin Up',
            'Weighted Pull Up', 'Face Pull', 'Deadlift', 'Rack Pull',
            'Straight Arm Pulldown', 'Low Cable Row'
        ],
        '🔵 Omuz': [
            'Overhead Press (Barbell)', 'Dumbbell Shoulder Press',
            'Arnold Press', 'Lateral Raise', 'Cable Lateral Raise',
            'Front Raise', 'Rear Delt Fly', 'Rear Delt Cable Fly',
            'Face Pull', 'Upright Row', 'Shoulder Press Machine',
            'Bradford Press', 'Lu Raise'
        ],
        '🦵 Bacak': [
            'Squat', 'Front Squat', 'Hack Squat', 'Leg Press',
            'Bulgarian Split Squat', 'Romanian Deadlift', 'Leg Extension',
            'Leg Curl', 'Seated Leg Curl', 'Hip Thrust', 'Glute Bridge',
            'Walking Lunges', 'Reverse Lunge', 'Step Up',
            'Calf Raise (Ayakta)', 'Calf Raise (Oturur)', 'Sumo Squat'
        ],
        '💪 Biceps': [
            'Barbell Curl', 'Dumbbell Curl', 'Hammer Curl',
            'Incline Dumbbell Curl', 'Concentration Curl',
            'Preacher Curl', 'EZ Bar Curl', 'Cable Curl',
            'Cross Body Curl', 'Spider Curl', '21s'
        ],
        '🔴 Triceps': [
            'Tricep Pushdown (Düz Bar)', 'Tricep Pushdown (V-Bar)',
            'Rope Pushdown', 'Skull Crusher', 'Close Grip Bench Press',
            'Overhead Tricep Extension', 'Dips (Triceps)',
            'Weighted Dips (Triceps)', 'Kickback', 'Diamond Push Up',
            'JM Press', 'Single Arm Cable Pushdown'
        ],
        '⚡ Karın': [
            'Crunch', 'Cable Crunch', 'Leg Raise', 'Hanging Leg Raise',
            'Ab Wheel Rollout', 'Plank', 'Side Plank', 'Russian Twist',
            'Decline Sit Up', 'Dragon Flag', 'Pallof Press', 'Dead Bug'
        ],
        '🟡 Güç / Olimpik': [
            'Power Clean', 'Hang Clean', 'Push Press', 'Jerk',
            'Snatch', 'Clean & Jerk', 'Good Morning', 'Kettlebell Swing',
            'Box Jump', 'Trap Bar Deadlift', 'Farmers Walk', 'Sled Push'
        ]
    };

    function initExerciseAutocomplete() {
        const input = $('#prog-exercise-name');
        const dropdown = $('#exercise-suggestions');
        if (!input || !dropdown) return;

        // Build full list (flat)
        const allExercises = Object.values(EXERCISE_LIBRARY).flat();

        function buildDropdown(filter) {
            filter = (filter || '').toLowerCase().trim();
            let html = '';

            for (const [cat, exercises] of Object.entries(EXERCISE_LIBRARY)) {
                const filtered = filter
                    ? exercises.filter(ex => ex.toLowerCase().includes(filter))
                    : exercises;
                if (filtered.length === 0) continue;

                html += `<div class="suggestion-category">${cat}</div>`;
                html += filtered.map(ex =>
                    `<div class="suggestion-item${input.value === ex ? ' selected' : ''}" data-exercise="${ex}">${ex}</div>`
                ).join('');
            }

            if (!html) {
                html = `<div class="suggestion-empty">Hareket bulunamadı. İsmini yazıp ekleyebilirsin.</div>`;
            }

            dropdown.innerHTML = html;

            // Bind clicks
            dropdown.querySelectorAll('.suggestion-item').forEach(item => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    input.value = item.dataset.exercise;
                    closeDropdown();
                    input.focus();
                });
            });
        }

        function openDropdown() {
            buildDropdown(input.value);
            dropdown.style.display = 'block';
        }

        function closeDropdown() {
            dropdown.style.display = 'none';
        }

        // Events
        input.addEventListener('focus', () => openDropdown());

        input.addEventListener('input', () => {
            openDropdown();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeDropdown(); return; }
            if (e.key === 'Tab') { closeDropdown(); return; }

            if (dropdown.style.display !== 'none') {
                const items = [...dropdown.querySelectorAll('.suggestion-item')];
                const current = dropdown.querySelector('.suggestion-item.active');
                let idx = items.indexOf(current);

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (current) current.classList.remove('active');
                    idx = Math.min(idx + 1, items.length - 1);
                    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (current) current.classList.remove('active');
                    idx = Math.max(idx - 1, 0);
                    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'Enter' && current) {
                    e.preventDefault();
                    input.value = current.dataset.exercise;
                    closeDropdown();
                }
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                closeDropdown();
            }
        });
    }

    // ========== PROGRAM PAGE ==========

    const RPE_MEANINGS = {
        '10': 'Ne daha fazla ağırlık, ne daha fazla tekrar yapılmazdı, maksimum efor.',
        '9.5': 'Belki 1 tekrar ya da biraz daha ağır yapılabilirdi.',
        '9': '1 tekrar daha yapılabilirdi. (Tankta 1 kaldı)',
        '8.5': 'Kesin 1, belki 2 tekrar yapılabilirdi.',
        '8': '2 tekrar daha yapılabilirdi.',
        '7.5': 'Kesin 2, belki 3 tekrar yapılabilirdi.',
        '7': '3 tekrar daha yapılabilirdi.',
        '6.5': '4-5 tekrar daha yapılabilirdi.',
        '6': '4-5 tekrar daha yapılabilirdi.',
        '5.5': '4-5 tekrar daha yapılabilirdi.',
        '5': '4-5 tekrar daha yapılabilirdi.',
        '4.5': 'Oldukça basit efor.',
        '4': 'Oldukça basit efor.',
        '3.5': 'Oldukça basit efor.',
        '3': 'Oldukça basit efor.',
        '2.5': 'Oldukça basit efor.',
        '2': 'Oldukça basit efor.',
        '1.5': 'Oldukça basit efor.',
        '1': 'Oldukça basit efor.'
    };

    function updateRPEDescription(val) {
        const desc = $('#rpe-description');
        if (!desc) return;

        const num = parseFloat(val);
        let text = RPE_MEANINGS[val];

        if (!text) {
            // Groupings for potential missing keys
            if (num <= 4) text = RPE_MEANINGS['4'];
            else if (num <= 6) text = RPE_MEANINGS['6'];
            else text = 'Zorluk seviyesi seçin.';
        }
        desc.textContent = text;
    }

    function renderProgramPage() {
        const programs = Store.getPrograms();
        const currentProg = Store.getCurrentProgram();
        const logs = Store.getProgramLogs();

        renderProgramSelector(programs);
        renderProgramList(currentProg.exercises);
        renderExerciseSelect(currentProg.exercises);
        renderProgramLogs(logs);
    }

    function renderProgramSelector(programs) {
        const select = $('#program-select');
        const daySelect = $('#program-day-select');
        if (!select || !daySelect) return;

        select.innerHTML = programs.items.map(p =>
            `<option value="${p.id}"${p.id === programs.currentId ? ' selected' : ''}>${p.name}</option>`
        ).join('');

        const currentProg = programs.items.find(p => p.id === programs.currentId);
        daySelect.value = currentProg ? (currentProg.day || '') : '';
    }

    function renderProgramList(program) {
        const container = $('#program-list');
        if (program.length === 0) {
            container.innerHTML = '<p class="empty-state">Henüz hareket eklenmedi.</p>';
            return;
        }
        container.innerHTML = program.map(ex => `
            <div class="data-item">
                <div class="data-item-info">
                    <span class="data-item-primary">${ex.exercise}</span>
                    <span class="data-item-secondary">${ex.targetSets} set × ${ex.targetReps} tekrar</span>
                </div>
                <button class="btn-delete" onclick="FitTrack.deleteProgramExercise('${ex.id}')">🗑️</button>
            </div>
        `).join('');
    }

    // Stores program exercises for the log autocomplete
    let _logProgramExercises = [];

    function renderExerciseSelect(program) {
        _logProgramExercises = program.map(ex => ex.exercise);
        // Refresh autocomplete data if already open
        const dropdown = $('#log-exercise-suggestions');
        if (dropdown && dropdown.style.display !== 'none') {
            _buildLogDropdown($('#log-exercise-input')?.value || '');
        }
    }

    function renderProgramLogs(logs) {
        const container = $('#program-log-list');
        if (logs.length === 0) {
            container.innerHTML = '<p class="empty-state">Henüz kayıt yok.</p>';
            return;
        }
        const sorted = [...logs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
        container.innerHTML = sorted.map(log => {
            const rpeClass = log.rpe <= 4 ? 'rpe-low' : log.rpe <= 7 ? 'rpe-mid' : 'rpe-high';
            const rpeDesc = RPE_MEANINGS[log.rpe] || '';
            return `<div class="data-item">
                <div class="data-item-info">
                    <span class="data-item-primary">${log.exercise}</span>
                    <span class="data-item-secondary">${formatDate(log.date)} · ${log.weight}kg · ${log.sets}×${log.reps} <span class="log-rpe ${rpeClass}">RPE ${log.rpe}</span></span>
                    ${rpeDesc ? `<p class="log-rpe-note">${rpeDesc}</p>` : ''}
                </div>
                <button class="btn-delete" onclick="FitTrack.deleteProgramLog('${log.id}')">🗑️</button>
            </div>`;
        }).join('');
    }

    function handleAddProgramExercise(e) {
        e.preventDefault();
        const exercise = $('#prog-exercise-name').value.trim();
        const targetSets = parseInt($('#prog-target-sets').value) || 3;
        const targetReps = parseInt($('#prog-target-reps').value) || 10;
        if (!exercise) return;
        Store.addProgramExercise({ id: generateId(), exercise, targetSets, targetReps });
        $('#prog-exercise-name').value = '';
        $('#prog-target-sets').value = '3';
        $('#prog-target-reps').value = '10';
        showToast(`${exercise} programa eklendi ✓`);
        renderProgramPage();
    }

    function handleLogProgramWorkout(e) {
        e.preventDefault();
        const exercise = ($('#log-exercise-input')?.value || '').trim();
        const weight = parseFloat($('#log-weight').value) || 0;
        const sets = parseInt($('#log-sets').value) || 3;
        const reps = parseInt($('#log-reps').value) || 10;
        const rpe = $('#log-rpe').value;
        if (!exercise) { showToast('Lütfen hareket seçin', true); return; }
        if (weight <= 0) { showToast('Lütfen ağırlık girin', true); return; }
        Store.addProgramLog({ id: generateId(), date: todayStr(), exercise, weight, sets, reps, rpe });
        if ($('#log-exercise-input')) $('#log-exercise-input').value = '';
        $('#log-weight').value = '';
        $('#log-rpe').value = '5';
        $('#rpe-value').textContent = '5';
        updateRPEDescription('5');
        showToast(`${exercise} kaydedildi ✓`);
        renderProgramPage();
    }

    // ---- Log Exercise Autocomplete ----
    function _buildLogDropdown(filter) {
        const input = $('#log-exercise-input');
        const dropdown = $('#log-exercise-suggestions');
        if (!input || !dropdown) return;

        filter = (filter || '').toLowerCase().trim();
        let html = '';

        // 1. Program exercises section (if any)
        if (_logProgramExercises.length > 0) {
            const filtered = filter
                ? _logProgramExercises.filter(ex => ex.toLowerCase().includes(filter))
                : _logProgramExercises;
            if (filtered.length > 0) {
                html += `<div class="suggestion-category">📋 Programımdaki Hareketler</div>`;
                html += filtered.map(ex =>
                    `<div class="suggestion-item log-prog-item" data-exercise="${ex}">${ex}</div>`
                ).join('');
            }
        }

        // 2. Full library
        for (const [cat, exercises] of Object.entries(EXERCISE_LIBRARY)) {
            const filtered = filter
                ? exercises.filter(ex => ex.toLowerCase().includes(filter))
                : exercises;
            // Skip if already shown in program section
            const pruned = filtered.filter(ex => !_logProgramExercises.includes(ex));
            if (pruned.length === 0) continue;
            html += `<div class="suggestion-category">${cat}</div>`;
            html += pruned.map(ex =>
                `<div class="suggestion-item" data-exercise="${ex}">${ex}</div>`
            ).join('');
        }

        if (!html) {
            html = `<div class="suggestion-empty">Hareket bulunamadı. İsmini yazıp kaydedebilirsin.</div>`;
        }

        dropdown.innerHTML = html;

        dropdown.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = item.dataset.exercise;
                dropdown.style.display = 'none';
                input.focus();
            });
        });
    }

    function initLogExerciseAutocomplete() {
        const input = $('#log-exercise-input');
        const dropdown = $('#log-exercise-suggestions');
        if (!input || !dropdown) return;

        function open() {
            _buildLogDropdown(input.value);
            dropdown.style.display = 'block';
        }
        function close() { dropdown.style.display = 'none'; }

        input.addEventListener('focus', open);
        input.addEventListener('input', open);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { close(); return; }
            if (e.key === 'Tab') { close(); return; }
            if (dropdown.style.display !== 'none') {
                const items = [...dropdown.querySelectorAll('.suggestion-item')];
                const current = dropdown.querySelector('.suggestion-item.active');
                let idx = items.indexOf(current);
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (current) current.classList.remove('active');
                    idx = Math.min(idx + 1, items.length - 1);
                    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (current) current.classList.remove('active');
                    idx = Math.max(idx - 1, 0);
                    if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'Enter' && current) {
                    e.preventDefault();
                    input.value = current.dataset.exercise;
                    close();
                }
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) close();
        });
    }

    function handleAddProgram(e) {
        const name = prompt('Program adı girin:');
        if (name) {
            Store.addProgram(name);
            renderProgramPage();
            showToast(`${name} oluşturuldu ✓`);
        }
    }

    function handleDeleteProgram(e) {
        const programs = Store.getPrograms();
        if (programs.items.length <= 1) {
            showToast('Son programı silemezsiniz', true);
            return;
        }
        const current = Store.getCurrentProgram();
        if (confirm(`"${current.name}" programını silmek istediğinize emin misiniz?`)) {
            Store.deleteProgram(current.id);
            renderProgramPage();
            showToast('Program silindi ✓');
        }
    }

    // ========== AI RECOMMENDATIONS ==========
    async function generateAIRecommendations() {
        const currentProg = Store.getCurrentProgram();
        const logs = Store.getProgramLogs();
        const container = $('#ai-recommendations');
        const refreshBtn = $('#btn-refresh-recommendations');

        if (currentProg.exercises.length === 0 || logs.length === 0) {
            container.innerHTML = '<p class="empty-state">Programınıza hareket ekleyin ve antrenman kaydedin.</p>';
            refreshBtn.style.display = 'none';
            return;
        }

        const apiKey = Store.getApiKey();
        if (!apiKey) {
            container.innerHTML = '<p class="empty-state">AI tavsiyeler için Profil sayfasından API anahtarı girin.</p>';
            refreshBtn.style.display = 'none';
            return;
        }

        refreshBtn.style.display = 'flex';

        // Build exercise data summary
        const exerciseData = currentProg.exercises.map(ex => {
            const exLogs = logs
                .filter(l => l.exercise === ex.exercise)
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 5);
            return {
                exercise: ex.exercise,
                targetSets: ex.targetSets,
                targetReps: ex.targetReps,
                recentLogs: exLogs.map(l => ({
                    date: l.date,
                    weight: l.weight,
                    sets: l.sets,
                    reps: l.reps,
                    rpe: l.rpe
                }))
            };
        }).filter(ex => ex.recentLogs.length > 0);

        if (exerciseData.length === 0) {
            container.innerHTML = '<p class="empty-state">Antrenman kayıtlarınız henüz analiz için yeterli değil.</p>';
            return;
        }

        container.innerHTML = '<p class="empty-state">🤖 AI analiz ediyor...</p>';

        try {
            const prompt = `Sen bir fitness koçusun. Aşağıdaki antrenman verilerini analiz et ve her hareket için sonraki antrenmanda ne yapılması gerektiğini öner.

Kurallar:
- RPE 1-4: kolay, ağırlık artırılabilir
- RPE 5-7: uygun zorluk, duruma göre küçük artış veya aynı kal
- RPE 8-10: çok zor, ağırlık azaltılmalı veya set/tekrar düşürülmeli
- Progressive overload prensibi uygula
- Ağırlık artışını 2.5kg adımlarla öner
- Türkçe cevap ver

Veriler:
${JSON.stringify(exerciseData, null, 2)}

JSON formatında cevap ver. Her hareket için:
{"recommendations": [
  {
    "exercise": "hareket adı",
    "action": "increase" | "maintain" | "decrease",
    "suggestion": "kısa tavsiye metni, ör: Ağırlık artır: 60kg → 62.5kg, 3×10",
    "reasoning": "kısa açıklama"
  }
]}
Sadece JSON döndür, başka bir şey yazma.`;

            const data = await Store.callGemini(prompt);
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('AI yanıtı okunamadı');

            const result = JSON.parse(jsonMatch[0]);
            const recs = result.recommendations || [];

            if (recs.length === 0) throw new Error('Tavsiye oluşturulamadı');

            // Render recommendations
            container.innerHTML = recs.map(rec => {
                const exLogs = logs.filter(l => l.exercise === rec.exercise).sort((a, b) => b.date.localeCompare(a.date));
                const lastLog = exLogs[0];
                const current = lastLog ? `Son: ${lastLog.weight}kg · ${lastLog.sets}×${lastLog.reps} · RPE ${lastLog.rpe}` : '';
                return `<div class="ai-rec-item rec-${rec.action}">
                    <span class="ai-rec-exercise">${rec.exercise}</span>
                    ${current ? `<span class="ai-rec-current">${current}</span>` : ''}
                    <span class="ai-rec-suggestion">💡 ${rec.suggestion}</span>
                </div>`;
            }).join('');

        } catch (err) {
            console.error('AI recommendation error:', err);
            // Show fallback rule-based recommendations
            renderFallbackRecommendations(exerciseData, container);
        }
    }

    function renderFallbackRecommendations(exerciseData, container) {
        container.innerHTML = exerciseData.map(ex => {
            const last = ex.recentLogs[0];
            if (!last) return '';
            let action, suggestion;
            if (last.rpe <= 4) {
                action = 'increase';
                suggestion = `Ağırlık artır: ${last.weight}kg → ${last.weight + 2.5}kg, ${last.sets}×${last.reps}`;
            } else if (last.rpe <= 7) {
                action = 'maintain';
                suggestion = `Aynı ağırlıkla devam: ${last.weight}kg, ${last.sets}×${last.reps}`;
            } else {
                action = 'decrease';
                suggestion = `Ağırlık düşür veya tekrar azalt: ${last.weight}kg → ${Math.max(last.weight - 2.5, 0)}kg`;
            }
            return `<div class="ai-rec-item rec-${action}">
                <span class="ai-rec-exercise">${ex.exercise}</span>
                <span class="ai-rec-current">Son: ${last.weight}kg · ${last.sets}×${last.reps} · RPE ${last.rpe}</span>
                <span class="ai-rec-suggestion">💡 ${suggestion}</span>
            </div>`;
        }).join('');
    }

    // ========== GLOBAL API ==========
    window.FitTrack = {
        deleteWorkout(id) { Store.deleteWorkout(id); showToast('Silindi'); renderExercisesPage(); },
        deleteMeal(id) { Store.deleteMeal(id); showToast('Silindi'); renderCaloriePage(); },
        deleteProgramExercise(id) { Store.deleteProgramExercise(id); showToast('Silindi'); renderProgramPage(); },
        deleteProgramLog(id) { Store.deleteProgramLog(id); showToast('Silindi'); renderProgramPage(); }
    };

    // ========== AI PROGRAM GENERATION ==========
    let _lastGeneratedProgram = null;

    function renderAIProgramPage() {
        const profile = Store.getProfile();
        if ($('#ai-height')) $('#ai-height').value = profile.height || 175;
        if ($('#ai-weight')) $('#ai-weight').value = profile.bodyWeight || 75;

        // Reset result view
        $('#ai-program-result').style.display = 'none';
        $('#ai-program-loading').style.display = 'none';
    }

    async function handleGenerateAIProgram(e) {
        e.preventDefault();
        const apiKey = Store.getApiKey();
        if (!apiKey) {
            showToast('Lütfen Profil sayfasından AI API anahtarı girin.', true);
            navigateTo('profile');
            return;
        }

        const data = {
            height: $('#ai-height').value,
            weight: $('#ai-weight').value,
            fat: $('#ai-fat').value,
            gender: $('#ai-gender').value,
            days: $('#ai-days').value,
            goal: $('#ai-goal').value
        };

        $('#ai-program-loading').style.display = 'flex';
        $('#ai-program-result').style.display = 'none';
        $('#ai-program-form').style.opacity = '0.5';
        $('#ai-program-form').style.pointerEvents = 'none';

        try {
            const prompt = `Sen bir fitness uzmanısın. Kullanıcı verilerine göre haftalık ${data.days} günlük bir antrenman programı oluştur.
            Kullanıcı: ${data.gender}, ${data.height}cm, ${data.weight}kg, %${data.fat || 'bilinmiyor'} yağ oranı. Hedef: ${data.goal}.
            
            Programı JSON formatında ver. Her gün için gün adı ve o günkü hareketler (hareket adı, set, tekrar) olsun. 
            Hareket isimleri bilinen spor terimleri olmalı (ör: Bench Press, Squat).
            
            JSON formatı:
            {
              "programName": "AI - ${data.goal}",
              "days": [
                {
                  "dayName": "1. Gün (Tüm Vücut / veya bölge)",
                  "exercises": [
                    {"exercise": "Hareket Adı", "targetSets": 3, "targetReps": 10},
                    ...
                  ]
                },
                ...
              ]
            }
            Sadece JSON döndür.`;

            const result = await Store.callGemini(prompt);
            let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            // Strip markdown code blocks if present
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            _lastGeneratedProgram = JSON.parse(text);

            renderGeneratedProgram(_lastGeneratedProgram);
            $('#ai-program-result').style.display = 'block';
            window.scrollTo({ top: $('#ai-program-result').offsetTop - 20, behavior: 'smooth' });

        } catch (err) {
            console.error('AI Program Error:', err);
            showToast(`Hata: ${err.message || 'Bilinmeyen bir sorun oluştu'}`, true);
        } finally {
            $('#ai-program-loading').style.display = 'none';
            $('#ai-program-form').style.opacity = '1';
            $('#ai-program-form').style.pointerEvents = 'auto';
        }
    }

    function renderGeneratedProgram(program) {
        const container = $('#generated-program-content');
        let html = `<h2>${program.programName}</h2>`;

        program.days.forEach(day => {
            html += `
                <div class="ai-workout-day">
                    <h4>${day.dayName}</h4>
                    <div class="ai-exercises">
                        ${day.exercises.map(ex => `
                            <div class="ai-exercise-item">
                                <span class="ai-exercise-name">${ex.exercise}</span>
                                <span class="ai-exercise-sets">${ex.targetSets} × ${ex.targetReps}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    function handleSaveAIProgram() {
        if (!_lastGeneratedProgram) return;

        const programs = Store.getPrograms();
        const newProgramId = generateId();

        // Flatten exercises for now as current Store structure might not support multi-day sub-structures perfectly
        // But the user asked to "add to programs", so let's try to fit it into the existing structure.
        // Existing structure: { id, name, exercises: [{id, exercise, targetSets, targetReps}], day }

        // Option 1: Create a single program with all exercises (not ideal for multi-day)
        // Option 2: Create multiple programs (one for each day)
        // Let's go with Option 2 for better organization in the current UI.

        _lastGeneratedProgram.days.forEach((day, index) => {
            const progId = generateId();
            const exercises = day.exercises.map(ex => ({
                id: generateId(),
                exercise: ex.exercise,
                targetSets: ex.targetSets,
                targetReps: ex.targetReps
            }));

            // Guess the day index (Monday, etc.) if possible, or leave empty
            // For now, let's just use the sequence
            const dayIdx = ((index + 1) % 7).toString();

            const data = Store.getPrograms();
            data.items.push({
                id: progId,
                name: `${_lastGeneratedProgram.programName} - ${day.dayName}`,
                exercises: exercises,
                day: '' // Optional for now
            });
            Store.setPrograms(data);
        });

        showToast('Programlar kaydedildi ✓');
        navigateTo('program');
    }

    // ========== NOTIFICATIONS ==========
    async function requestNotificationPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') {
            await Notification.requestPermission();
        }
    }

    function checkProgramNotifications() {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        const data = Store.getPrograms();
        const todayIdx = new Date().getDay().toString(); // "0" (Pazar) to "6" (Cumartesi)

        // Find programs scheduled for today
        const todaysPrograms = data.items.filter(p => p.day === todayIdx);

        if (todaysPrograms.length > 0) {
            // Check if we already notified today (simple session-based check to avoid spamming on every refresh)
            const sessionKey = 'notified_' + todayStr();
            if (sessionStorage.getItem(sessionKey)) return;

            todaysPrograms.forEach(prog => {
                new Notification('FitTrack Hatırlatıcısı', {
                    body: `Bugün günlerden "${prog.name}"! Antrenmanını unutma. 💪`,
                    icon: 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><rect fill=\'%230a0e27\' width=\'100\' height=\'100\' rx=\'20\'/><text y=\'68\' x=\'50\' text-anchor=\'middle\' font-size=\'50\'>🏋️</text></svg>'
                });
            });

            sessionStorage.setItem(sessionKey, 'true');
        }
    }

    // ========== INIT ==========
    function init() {
        console.log('FitTrack init() starting...');
        initNavigation();

        // Forms
        $('#workout-form').addEventListener('submit', handleAddWorkout);
        $('#meal-form').addEventListener('submit', handleAddMeal);
        $('#profile-form').addEventListener('submit', handleSaveProfile);
        $('#api-key-form').addEventListener('submit', handleSaveApiKey);

        // AI buttons
        $('#btn-ai-estimate').addEventListener('click', handleAIEstimate);
        $('#photo-input').addEventListener('change', handlePhotoSelect);
        $('#btn-remove-photo').addEventListener('click', handleRemovePhoto);

        // Smart portion unit selector - update dropdown as user types
        let portionDebounce = null;
        $('#meal-name').addEventListener('input', (e) => {
            clearTimeout(portionDebounce);
            portionDebounce = setTimeout(() => updatePortionUnits(e.target.value), 300);
        });
        updatePortionUnits(''); // initialize with default units

        // Exercise filter
        $('#history-exercise-filter').addEventListener('change', renderExerciseHistory);

        // Data management
        $('#btn-export').addEventListener('click', handleExportData);
        $('#btn-reset').addEventListener('click', handleResetData);

        // Program forms
        if ($('#program-exercise-form')) $('#program-exercise-form').addEventListener('submit', handleAddProgramExercise);
        if ($('#program-log-form')) $('#program-log-form').addEventListener('submit', handleLogProgramWorkout);
        if ($('#log-rpe')) {
            $('#log-rpe').addEventListener('input', (e) => {
                const val = e.target.value;
                const badge = $('#rpe-value');
                if (badge) {
                    badge.textContent = val;
                    badge.style.background = val <= 4 ? 'rgba(0,212,170,0.15)' : val <= 7 ? 'rgba(255,179,71,0.15)' : 'rgba(255,77,106,0.15)';
                    badge.style.color = val <= 4 ? '#00d4aa' : val <= 7 ? '#ffb347' : '#ff4d6a';
                }
                updateRPEDescription(val);
            });
        }
        // Program Switch
        $('#program-select')?.addEventListener('change', (e) => {
            Store.switchProgram(e.target.value);
            renderProgramPage();
        });

        // Program Day Switch
        $('#program-day-select')?.addEventListener('change', (e) => {
            const currentProg = Store.getCurrentProgram();
            if (currentProg) {
                Store.updateProgramDay(currentProg.id, e.target.value);
                showToast('Program günü güncellendi ✓');
            }
        });

        $('#btn-add-program')?.addEventListener('click', handleAddProgram);
        if ($('#btn-delete-program')) $('#btn-delete-program').addEventListener('click', handleDeleteProgram);
        if ($('#btn-refresh-recommendations')) $('#btn-refresh-recommendations').addEventListener('click', generateAIRecommendations);

        // Autocomplete for program exercise inputs
        initExerciseAutocomplete();
        initLogExerciseAutocomplete();
        initExerciseTakipAutocomplete();

        // AI Program Generation
        $('#ai-program-form')?.addEventListener('submit', handleGenerateAIProgram);
        $('#btn-save-ai-program')?.addEventListener('click', handleSaveAIProgram);

        // Initial render
        renderDashboard();
        generateAIRecommendations();
        if ($('#workout-date')) $('#workout-date').value = todayStr();

        // Check notifications
        requestNotificationPermission().then(() => {
            checkProgramNotifications();
        });

    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
