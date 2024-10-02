const express = require("express");
const router = express.Router();

const {
  procesoVentaPedido,
} = require("../controllers/procesoVentaPedidosControllers");

router.get("/proceso-venta-pedido", procesoVentaPedido);

module.exports = router;
