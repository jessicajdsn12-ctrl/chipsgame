CREATE DATABASE IF NOT EXISTS comparador_juegos;
USE comparador_juegos;

 
CREATE TABLE IF NOT EXISTS tiendas (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    nombre    VARCHAR(50)  NOT NULL UNIQUE,
    url_base  VARCHAR(255) NOT NULL
);
 

CREATE TABLE IF NOT EXISTS juegos (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    titulo            VARCHAR(150) NOT NULL UNIQUE,
    juego_id_externo  VARCHAR(50)  UNIQUE,
    imagen_url        VARCHAR(255)
);
 

CREATE TABLE IF NOT EXISTS precios (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    juego_id             INT NOT NULL,
    tienda_id            INT NOT NULL,
    precio_actual        DECIMAL(6, 2) NOT NULL,
    fecha_actualizacion  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
 
    UNIQUE KEY uq_juego_tienda (juego_id, tienda_id),
 
    FOREIGN KEY (juego_id)  REFERENCES juegos(id)  ON DELETE CASCADE,
    FOREIGN KEY (tienda_id) REFERENCES tiendas(id) ON DELETE CASCADE
);
 
