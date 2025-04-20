document.addEventListener("DOMContentLoaded", function () {
    const CSV_URLS = {
        "C. Festivo": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=116595730&single=true&output=csv",
        "C. Cumpleaños": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=1057098377&single=true&output=csv",
        "C. Eventos": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=572595958&single=true&output=csv",
        "C. Salud": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=1882034969&single=true&output=csv",
        "C. Financiero": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=186154943&single=true&output=csv",
        "C. Académico": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=1700481828&single=true&output=csv",
        "C. Familiar": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=386837505&single=true&output=csv",
        "C. Experiencias": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYzTWiJZNButAQI9Pb_RzSQVjmtVejrhr-NQz7uiyFPwMXWgfrN-athIMXu7EZcaj_HzRi1Qa4G3fs/pub?gid=582170139&single=true&output=csv"
    };

    let SHEET_NAME = "C. Académico";
    const calendarioDiv = document.getElementById("calendario");

    const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const diasPorMes = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const diasSemana = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

    let eventos = [];
    let festivos = [];

    function emojiPorHoja(hoja) {
        const mapa = {
            "C. Cumpleaños": "🎂",
            "C. Salud": "🩺",
            "C. Financiero": "💰",
            "C. Académico": "📚",
            "C. Familiar": "👨‍👩‍👧",
            "C. Experiencias": "🌟",
            "C. Festivo": "🎉"
        };
        return mapa[hoja] || "📌";
    }

    function cargarEventos(hoja) {
        const url = CSV_URLS[hoja];
        eventos = [];

        fetch(url)
            .then(response => response.text())
            .then(data => {
                const filas = data.split("\n").slice(1);

                filas.forEach(fila => {
                    const [fecha, descripcion] = fila.split(",").map(campo => campo.trim());

                    if (fecha && descripcion) {
                        const [dia, mes, año] = fecha.split("/").map(Number);
                        eventos.push({ dia, mes, descripcion, hoja });
                    }
                });

                generarCalendario();
            });
    }

    function cargarFestivos() {
        const url = CSV_URLS["C. Festivo"];
        festivos = [];

        fetch(url)
            .then(response => response.text())
            .then(data => {
                const filas = data.split("\n").slice(1);
                filas.forEach(fila => {
                    const [fecha, nombre] = fila.split(",").map(campo => campo.trim());
                    if (fecha && nombre) {
                        const [dia, mes, año] = fecha.split("/").map(Number);
                        festivos.push({ dia, mes, nombre });
                    }
                });

                cargarEventos(SHEET_NAME);
            });
    }

    function generarCalendario() {
        calendarioDiv.innerHTML = "";

        let hoy = new Date();
        let diaHoy = hoy.getDate();
        let mesHoy = hoy.getMonth() + 1;

        for (let i = 0; i < 12; i++) {
            let mesDiv = document.createElement("div");
            mesDiv.classList.add("mes");

            let titulo = document.createElement("h3");
            titulo.textContent = meses[i];
            mesDiv.appendChild(titulo);

            let diasContainer = document.createElement("div");
            diasContainer.classList.add("dias-container");

            for (let dia of diasSemana) {
                let diaSemanaDiv = document.createElement("div");
                diaSemanaDiv.classList.add("dia-semana");
                diaSemanaDiv.textContent = dia;
                diasContainer.appendChild(diaSemanaDiv);
            }

            let fechaInicio = new Date(2025, i, 1);
            let primerDiaSemana = fechaInicio.getDay();

            for (let j = 0; j < primerDiaSemana; j++) {
                let espacioVacio = document.createElement("div");
                espacioVacio.classList.add("dia", "vacio");
                diasContainer.appendChild(espacioVacio);
            }

            for (let d = 1; d <= diasPorMes[i]; d++) {
                let diaDiv = document.createElement("div");
                diaDiv.classList.add("dia");

                let numeroDia = document.createElement("span");
                numeroDia.textContent = d;
                diaDiv.appendChild(numeroDia);

                if (d === diaHoy && i + 1 === mesHoy) {
                    diaDiv.classList.add("hoy");
                }

                let festivo = festivos.find(f => f.dia === d && f.mes === i + 1);
                if (festivo) {
                    diaDiv.classList.add("festivo");
                    let festivoSpan = document.createElement("div");
                    festivoSpan.classList.add("evento", "evento-festivos");
                    festivoSpan.textContent = `🎉 ${festivo.nombre}`;
                    diaDiv.appendChild(festivoSpan);
                }

                let eventosDia = eventos.filter(e => e.dia === d && e.mes === i + 1);
                eventosDia.forEach(evento => {
                    let eventoSpan = document.createElement("div");
                    eventoSpan.classList.add("evento");
                    eventoSpan.textContent = `${emojiPorHoja(evento.hoja)} ${evento.descripcion}`;
                    diaDiv.appendChild(eventoSpan);
                });

                diasContainer.appendChild(diaDiv);
            }

            mesDiv.appendChild(diasContainer);
            calendarioDiv.appendChild(mesDiv);
        }
    }

    function mostrarEstadisticas() {
        const conteo = {};
        eventos.forEach(e => {
            conteo[e.hoja] = (conteo[e.hoja] || 0) + 1;
        });

        let statsDiv = document.createElement("div");
        statsDiv.innerHTML = "<h3>Resumen Morchis 💚</h3>";
        Object.entries(conteo).forEach(([hoja, cantidad]) => {
            let p = document.createElement("p");
            p.textContent = `${emojiPorHoja(hoja)} ${hoja}: ${cantidad} eventos`;
            statsDiv.appendChild(p);
        });

        calendarioDiv.appendChild(statsDiv);
    }

    document.querySelectorAll(".btn-hoja").forEach(boton => {
        boton.addEventListener("click", function () {
            SHEET_NAME = this.dataset.hoja;
            cargarEventos(SHEET_NAME);
        });
    });

    document.getElementById("btn-cronograma").addEventListener("click", function () {
        eventos = [];
        const promesas = Object.keys(CSV_URLS).filter(hoja => hoja !== "C. Festivo").map(hoja => {
            return fetch(CSV_URLS[hoja])
                .then(response => response.text())
                .then(data => {
                    const filas = data.split("\n").slice(1);
                    filas.forEach(fila => {
                        const [fecha, descripcion] = fila.split(",").map(campo => campo.trim());
                        if (fecha && descripcion) {
                            const [dia, mes, año] = fecha.split("/").map(Number);
                            eventos.push({ dia, mes, descripcion, hoja });
                        }
                    });
                });
        });

        Promise.all(promesas).then(() => {
            generarCalendario();
            mostrarEstadisticas();
        });
    });

    document.getElementById("btn-semanal").addEventListener("click", function () {
        eventos = [];
        const promesas = Object.keys(CSV_URLS).filter(hoja => hoja !== "C. Festivo").map(hoja => {
            return fetch(CSV_URLS[hoja])
                .then(response => response.text())
                .then(data => {
                    const filas = data.split("\n").slice(1);
                    filas.forEach(fila => {
                        const [fecha, descripcion] = fila.split(",").map(campo => campo.trim());
                        if (fecha && descripcion) {
                            const [dia, mes, año] = fecha.split("/").map(Number);
                            eventos.push({ dia, mes, descripcion, hoja });
                        }
                    });
                });
        });
    
        Promise.all(promesas).then(() => {
            let hoy = new Date();
            calendarioDiv.innerHTML = "<h3>Eventos Próximos 7 Días</h3>";
    
            let eventosSemana = eventos.filter(evento => {
                let fecha = new Date(2025, evento.mes - 1, evento.dia);
                let diff = (fecha - hoy) / (1000 * 60 * 60 * 24);
                return diff >= 0 && diff <= 7;
            });
    
            if (eventosSemana.length === 0) {
                calendarioDiv.innerHTML += "<p>No hay eventos esta semana 😌</p>";
            }
    
            eventosSemana.sort((a, b) => new Date(2025, a.mes - 1, a.dia) - new Date(2025, b.mes - 1, b.dia));
    
            eventosSemana.forEach(evento => {
                let div = document.createElement("div");
                div.classList.add("evento");
                div.textContent = `${evento.dia}/${evento.mes}: ${emojiPorHoja(evento.hoja)} ${evento.descripcion}`;
                calendarioDiv.appendChild(div);
            });
        });
    });    

    document.getElementById("selector-tema").addEventListener("change", e => {
        document.body.className = `tema-${e.target.value}`;
    });

    const frases = [
        "Hoy es un buen día para sonreír juntos 😊",
        "Recuerden tomar agüita y respirar 💚",
        "Una razón para celebrar: ¡ustedes existen!",
        "Morchis: un día más construyendo historia juntos",
        "Una cita inesperada puede cambiar el día ✨"
    ];
    let frase = frases[Math.floor(Math.random() * frases.length)];
    document.querySelector(".titulo h1").insertAdjacentHTML("beforeend", `<div class="frase">${frase}</div>`);

    cargarFestivos();
});
