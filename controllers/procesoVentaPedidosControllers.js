const axios = require("axios");
const logger = require("../config/logger.js");
const sql = require("mssql");
const {
  connectToDatabase,
  closeDatabaseConnection,
} = require("../config/database.js");
const { rolbackData } = require("../config/rolbackData.js");
require("dotenv").config();

/**
 * API que genera el proceso completo del servicio tecnico , crea nota de venta interna y nota de venta
 * @param {*} req
 * @param {*} res
 */
async function procesoVentaPedido(req, res) {
  try {
    logger.info(`Iniciamos la funcion procesoVentaPedidos`);

    const url = `http://api2.telecontrol.com.br/posvenda-pedido/pedidos/exportado/false`;

    logger.info(`URL :  ${url}`);

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        "Access-Application-Key": "588b56a33c722da5e49170a311e872d9ee967291",
        "Access-Env": "PRODUCTION",
        "X-Custom-Header": "value",
      },
    });

    // Filtrar el arreglo para obtener solo los objetos cuyo código es 'VEN'
    const pedidosVEN = response.data
      .filter((pedido) => pedido.codigo === "VEN")
      .map((pedido) => {
        return {
          ...pedido,
          tipoDocumento: "NOTA DE VENTA", // Agregar la nueva propiedad
        };
      });

    if (pedidosVEN.length > 0) {
      const validaEntidad = await dataValidaCliente(pedidosVEN);

      const insertarPedidos = await insertarPedidosVenta(validaEntidad);
      for(pedidoDetalle of insertarPedidos){
        if(pedidoDetalle.status === 0){
          for(item of pedidoDetalle.itens){

            item.idPedido = pedidoDetalle.pedido;
            item.rut = pedidoDetalle.cnpj.trim();
            item.tipoDocumento = pedidoDetalle.tipoDocumento;
            const insertarPedidoDetalle = await insertarPedidoDetalleVenta(item);
          }

          const reqData = {
            pedido: pedidoDetalle.pedido,
            tipoDocumento: pedidoDetalle.tipoDocumento,
            codigo_posto: pedidoDetalle.cnpj.trim(),
          }
          
          logger.info(`Ejecuta microservcio crear-documento-nota-venta`);
          const ingresaNotaVenta = await axios.post(`http://172.16.1.206:3016/ms/crear-documento-nota-venta`, reqData);
          logger.debug(`Respuesta microservcio crear-documento-nota-venta`);

          logger.info(`SE CREA EXITOSAMENTE EL DOCUMENTO!!`);
        }
      }
      
      res.status(200).json({resultado: insertarPedidos, });
    } else {
      res.status(200).json({ resultado: "sin pedidos para procesar" });
    }
  } catch (error) {
    logger.error(
      `Error al procesar pedidos de venta pendiente - [procesoVentaPedido]  ${error.message}`
    );

    // Enviar el correo electrónico en caso de un problema
    // await sendEmailWithDB(error);
    // vuelve atras en caso de falla
    if (pedidosInsertados.length > 0) {
      await rolbackData(pedidosInsertados);
    }

    if (error.response && error.response.data) {
      const mensajeError =
        error.response.data.mensaje ||
        error.response.data.error ||
        "Error desconocido";
      res.status(error.response.status || 500).json({ error: mensajeError });
    } else {
      res.status(500).json({ error: `Error en el servidor: ${error.message}` });
    }
  }
}

function formatRut(rut) {
  // Convertir el RUT a string por si acaso viene como número
  rut = rut.toString();

  // Verificar si el RUT ya tiene el guion
  if (rut.includes("-")) {
    return rut;
  }

  // Si no tiene guion, agregarlo antes del último dígito
  const rutBody = rut.slice(0, -1);
  const rutCheckDigit = rut.slice(-1);

  return `${rutBody}-${rutCheckDigit}`;
}

/**
 * Enviamos Pedidos para verificar si servicio tecnico es usuario makita
 * @param {*} pedidosList
 * @returns
 */
async function dataValidaCliente(pedidosList) {
  logger.info(`Iniciamos la funcion dataValidaCliente ${pedidosList}`);

  let newArray = [];
  let newData;

  try {
    for (const os of pedidosList) {
      const cnpj = formatRut(os.cnpj.trim());

      const data = {
        tabla: "Entidad",
        entidad: cnpj,
      };

      //microservicio validar-cliente-ms
      logger.info(`Ejecuta microservcio validar-cliente-ms`);
      const resultadoConsulta = await axios.post(
        `http://172.16.1.206:3013/ms/validar-cliente`,
        data
      );
      logger.debug(`Respuesta microservcio validar-cliente-ms`);

      // recorremos las ordenes de servicio si el length es mayo a 0 es por que el clienteexiste en makita.
      if (resultadoConsulta.data.length > 0) {
        for (dataServicioTecnico of resultadoConsulta.data) {
          os.direccion = dataServicioTecnico.Direccion;
        }
        newArray.push(os);
      } else {
        logger.info(`La data a procesar no es un servicio tecnico de makita`);
      }
    }
    logger.info(`Fin de la funcion dataValidaCliente`);
    return newArray;
  } catch (error) {
    logger.error(`Error en prepararPedidos: ${error.message}`);
    throw error; // Propaga el error a la función principal
  }
}

/**
 *
 * @param {*} pedidosList
 */
async function insertarPedidosVenta(pedidosList) {
  logger.info(`Iniciamos la funcion insertarPedidosVenta ${pedidosList}`);

  let result;
  let responseData = [];
 
  try {
    // Conectarse a la base de datos 'telecontrol'
    await connectToDatabase('Telecontrol');
    
    for (const element of pedidosList) {
      
      const request = new sql.Request(); // Nueva instancia de request en caditeracióna
      const {
        pedido: pedido,
        data: data,
        cnpj: cnpj,
        codigo: codigo,
        codigo_condicao: codigo_condicao,
        entrega: entrega,
        exportado: exportado,
        tipo_frete: tipo_frete,
        status_pedido: status_pedido,
        troca: troca,
        status_descricao: status_descricao,
        observacao: observacao,
        transportadora: transportadora,
        codigo_interno_transportadora: codigo_interno_transportadora,
        valor_adicional_fabricante: valor_adicional_fabricante,
        valor_descuento_fabricante,
        tipoDocumento: tipoDocumento,
        direccion: direccion,
      } = element;

      // Ejecutar el procedimiento almacenado con los parámetros
      const result = await request
    .input("pedido", sql.Int, pedido) // Cambiado a sql.Int
    .input("data", sql.DateTime, data) // Cambiado a sql.DateTime
    .input("cnpj", sql.VarChar(20), cnpj)
    .input("codigo", sql.VarChar(10), codigo)
    .input("codigo_condicao", sql.VarChar(10), codigo_condicao)
    .input("entrega", sql.VarChar(50), entrega)
    .input("exportado", sql.VarChar(50), exportado)
    .input("tipo_frete", sql.VarChar(50), tipo_frete)
    .input("status_pedido", sql.Int, status_pedido)
    .input("troca", sql.VarChar(50), troca)
    .input("status_descricao", sql.VarChar(50), status_descricao)
    .input("observacao", sql.VarChar(255), observacao)
    .input("transportadora", sql.VarChar(50), transportadora)
    .input("codigo_interno_transportadora", sql.VarChar(50), codigo_interno_transportadora)
    .input("valor_adicional_fabricante", sql.Decimal(18, 2), valor_adicional_fabricante) // Cambiado a sql.Decimal
    .input("valor_desconto_fabricante", sql.Decimal(18, 2), valor_descuento_fabricante) // Cambiado a sql.Decimal
    .input("tipoDocumento", sql.VarChar(50), tipoDocumento)
    .input("direccion", sql.VarChar(255), direccion)
    .output("glosa", sql.VarChar(255)) // Agregar parámetro de salida para glosa
    .output("resultado", sql.Int) // Agregar parámetro de salida para resultado
    .execute("insertaPedidoVenta");

      // Obtener los valores de salida
      const glosa = result.output.glosa;
      const resultado = result.output.resultado;
      // Manejar el resultado según el valor de `resultado`
      if (resultado === 1) {
        console.log(glosa); // El pedido ya fue ingresado
      } else {
        console.log(glosa); // El pedido fue ingresado correctamente
      }
      result.data = element;
      result.data.glosa = glosa;
      result.data.status = resultado;
      responseData.push( result.data);
    }
    
    logger.info(`Fin de la funcion insertarPedidos ${JSON.stringify(responseData)}`);
    return responseData;
  } catch (error) {
  
    // Manejamos cualquier error ocurrido durante el proceso
    logger.error(`Error en insertarPedidos: ${error.message}`);
    res.status(500).json({
      error: `Error en el servidor [insertar-pedidos-ms] :  ${error.message}`,
    });
  }finally{
    await closeDatabaseConnection();
  }
}


/**
 *
 * @param {*} item
 */
async function insertarPedidoDetalleVenta(item) {
  logger.info(`Iniciamos la funcion insertarPedidosDetalleVenta ${item}`);

  let result;
  let responseData = [];
 
  try {
    // Conectarse a la base de datos 'telecontrol'
    await connectToDatabase('Telecontrol');
    
    const request = new sql.Request(); // Nueva instancia de request en caditeracióna
      const {
        pedido_item,
        referencia,
        qtde,
        preco,
        ipi,
        os,
        qtde_cancelada,
        qtde_faturada,
        idPedido,
        rut
      } = item;

      const result = await request
    .input("pedido_item", sql.Int, pedido_item) // Cambiado a sql.Int
    .input("referencia", sql.VarChar(50), referencia) // Añadido para 'referencia'
    .input("qtde", sql.Int, qtde) // Cambiado a sql.Int
    .input("preco", sql.Decimal(10, 2), preco) // Cambiado a sql.Decimal
    .input("ipi", sql.Decimal(10, 2), ipi) // Cambiado a sql.Decimal
    .input("os", sql.VarChar(50), os) // Añadido para 'os'
    .input("qtde_cancelada", sql.Int, qtde_cancelada) // Cambiado a sql.Int
    .input("qtde_faturada", sql.Int, qtde_faturada) // Cambiado a sql.Int
    .input("idPedido", sql.Int, idPedido) // Cambiado a sql.Int
    .input("rut", sql.VarChar(12), rut)
    .input("tipoItem", sql.VarChar(50), '04-Repuestos')
    .input("descuento", sql.Int, 0)
    .input("descripcion", sql.VarChar(200), '')
    
    .execute("insertaPedidoDetalleVenta"); // Nombre del procedimiento almacenado

    result.data = item;
    
    logger.info(`Fin de la funcion insertarPedidosDetalleVenta ${JSON.stringify(result)}`);
    return result.data;
  } catch (error) {
  
    // Manejamos cualquier error ocurrido durante el proceso
    logger.error(`Error en insertarPedidosDetalleVenta: ${error.message}`);
    res.status(500).json({
      error: `Error en el servidor [insertarPedidosDetalleVenta] :  ${error.message}`,
    });
  }finally{
    await closeDatabaseConnection();
  }
}


module.exports = {
  procesoVentaPedido,
};
